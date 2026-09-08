//! Per-subscriber backpressure (architecture §7.4).
//!
//! A MessagePort/WebSocket has no `bufferedAmount` we can trust, so flow is
//! tracked by ACKs: each unsolicited push (a delta, an alert) carries a `seq`,
//! the client acks the highest it has applied, and the hub watches the lag.
//!
//! In this hub's PULL model conflation is automatic — each tick sends the
//! CUMULATIVE change since the last, so a slow client naturally receives fewer,
//! larger deltas rather than a growing queue. The ladder therefore reports the
//! rung (so a degraded subscriber is visible, not mistaken for a slow feed) and,
//! when the lag shows the client has stopped consuming entirely, disconnects it —
//! a stuck subscriber sitting on stale prices believing they are live is the one
//! outcome to avoid.

pub struct Flow {
    pub last_sent: u64,
    pub last_acked: u64,
    pub limit: u64,
}

impl Flow {
    pub fn new(limit: u64) -> Flow { Flow { last_sent: 0, last_acked: 0, limit: limit.max(2) } }

    /// Stamp the next outgoing push; returns its seq.
    pub fn next_seq(&mut self) -> u64 { self.last_sent += 1; self.last_sent }

    /// Record a client ack (monotonic).
    pub fn on_ack(&mut self, seq: u64) { if seq > self.last_acked { self.last_acked = seq; } }

    /// Unacked pushes in flight.
    pub fn lag(&self) -> u64 { self.last_sent.saturating_sub(self.last_acked) }

    /// The rung this subscriber is on.
    pub fn rung(&self) -> &'static str {
        let lag = self.lag();
        if lag == 0 { "none" }
        else if lag < self.limit / 2 { "conflating" }
        else if lag < self.limit { "snapshot-refresh" }
        else { "disconnecting" }
    }

    /// Has the client fallen so far behind it should be dropped?
    pub fn should_disconnect(&self) -> bool { self.lag() >= self.limit }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rungs_escalate_with_unacked_lag_and_recover_on_ack() {
        let mut f = Flow::new(10);
        assert_eq!(f.rung(), "none");
        for _ in 0..4 { f.next_seq(); }          // lag 4 (< limit/2)
        assert_eq!(f.rung(), "conflating");
        for _ in 0..3 { f.next_seq(); }          // lag 7 (< limit)
        assert_eq!(f.rung(), "snapshot-refresh");
        for _ in 0..5 { f.next_seq(); }          // lag 12 (>= limit)
        assert_eq!(f.rung(), "disconnecting");
        assert!(f.should_disconnect());
        f.on_ack(12);                             // client caught up
        assert_eq!(f.rung(), "none");
        assert!(!f.should_disconnect());
    }
}
