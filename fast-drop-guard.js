/**
 * Fast-Drop Recovery-Exit Guard (NORMAL positions).
 *
 * Detects a sharp drop in position value from a rolling high, then exits into a
 * bounce (rise from the low), at breakeven, or at a hard floor — rather than
 * dumping at the bottom. Pure state machine: caller injects `now` and threads
 * the returned { watch, samples } forward. No side effects, no imports.
 *
 * See docs/plans/2026-07-28-fast-drop-recovery-exit-design.md
 */

// value proxy: 1 + pnl_pct/100 (captures IL + price + fees)
const toFactor = (pnlPct) => 1 + pnlPct / 100;

/**
 * @param {object} p
 * @param {Array<{ts:number,factor:number}>} p.samples  prior rolling-window samples
 * @param {null|{active:boolean,lowFactor:number,enteredAt:number}} p.watch  prior watch state
 * @param {number|null} p.currentPnlPct  current PnL % (null/suspicious -> skip)
 * @param {number} p.now  timestamp (ms)
 * @param {object} p.cfg  management config
 * @returns {{watch:null|object, samples:Array, action:null|"FAST_DROP_EXIT", reason:string|null}}
 */
export function evaluateFastDropGuard({ samples = [], watch = null, currentPnlPct, now, cfg }) {
  if (!cfg?.fastDropGuardEnabled) {
    return { watch: null, samples, action: null, reason: null };
  }
  // Skip ticks with no usable pnl — never throw, never fire, leave state untouched.
  if (currentPnlPct == null || !Number.isFinite(currentPnlPct)) {
    return { watch, samples, action: null, reason: null };
  }

  const windowMs = (cfg.fastDropWindowMinutes ?? 15) * 60_000;
  const triggerPct = cfg.fastDropTriggerPct ?? 15;
  const bouncePct = cfg.fastDropBouncePct ?? 10;
  const hardFloorPct = cfg.fastDropHardFloorPct ?? -25;

  const factor = toFactor(currentPnlPct);

  // Append this sample, then drop anything older than the window.
  const kept = [...samples, { ts: now, factor }].filter((s) => now - s.ts <= windowMs);

  // ── Watching: look for an exit ─────────────────────────────────────
  if (watch?.active) {
    const lowFactor = Math.min(watch.lowFactor, factor); // keep trailing the bottom
    const nextWatch = { ...watch, active: true, lowFactor };

    // 1. Hard floor
    if (currentPnlPct <= hardFloorPct) {
      return {
        watch: nextWatch, samples: kept, action: "FAST_DROP_EXIT",
        reason: `Fast-drop hard floor: PnL ${currentPnlPct.toFixed(2)}% <= ${hardFloorPct}%`,
      };
    }
    // 2. Breakeven — takes priority over bounce: once PnL is back to >=0 the exit
    //    is genuinely "got out flat/green", the more meaningful label than a bounce
    //    off the low while still red. Same FAST_DROP_EXIT action either way.
    if (currentPnlPct >= 0) {
      return {
        watch: nextWatch, samples: kept, action: "FAST_DROP_EXIT",
        reason: `Fast-drop breakeven exit: PnL recovered to ${currentPnlPct.toFixed(2)}%`,
      };
    }
    // 3. Bounce off the low (still negative PnL)
    if (factor >= lowFactor * (1 + bouncePct / 100)) {
      const bounced = (factor / lowFactor - 1) * 100;
      return {
        watch: nextWatch, samples: kept, action: "FAST_DROP_EXIT",
        reason: `Fast-drop bounce exit: +${bounced.toFixed(2)}% off low (>= ${bouncePct}%), PnL ${currentPnlPct.toFixed(2)}%`,
      };
    }
    return { watch: nextWatch, samples: kept, action: null, reason: null };
  }

  // ── Idle: arm the watch on a sharp drop from the rolling high ──────
  const highFactor = Math.max(...kept.map((s) => s.factor));
  const dropFromHighPct = (factor / highFactor - 1) * 100;
  if (dropFromHighPct <= -triggerPct) {
    return {
      watch: { active: true, lowFactor: factor, enteredAt: now },
      samples: kept, action: null,
      reason: `Fast-drop armed: ${dropFromHighPct.toFixed(2)}% from rolling high (<= -${triggerPct}%)`,
    };
  }

  return { watch: watch ?? { active: false }, samples: kept, action: null, reason: null };
}
