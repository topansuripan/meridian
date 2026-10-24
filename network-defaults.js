import net from "node:net";

// Node's happy-eyeballs gives each resolved address only 250 ms, then abandons it for the next.
// api.telegram.org is ~175 ms from the VPS and its IPv6 address is unreachable there, so any
// event-loop stall during a connect dropped the IPv4 attempt and the request failed with
// "fetch failed (ETIMEDOUT [ETIMEDOUT, ENETUNREACH])". 5 s still falls back to IPv6 well
// inside undici's 10 s connect timeout.
net.setDefaultAutoSelectFamilyAttemptTimeout(5000);
