# Parked drafts

Complete findings, held out of `cairn/` because admitting them turns a test red
rather than because anything is wrong with them. Restore with:

    mv drafts/00NN-*.json cairn/ && npm run cairn:lint && npm run cairn:guard

## 0036 — pgrep wait loop matches its own command line
## 0037 — a ledger that records findings about itself

Both are firsthand, linted, and one has a passing automated check. Together
they flip a single agent-suite case, and the flip fails a test that predates
them (`test/retrieval.test.ts` — "retrieval works with no expansions file
present"):

    $ curl -sS --max-time 10 https://creativecommons.org
    saw:      curl: (56) CONNECT tunnel failed, response 403
    returned: cairn-0029, cairn-0001, cairn-0010    expected: cairn-0001

An agent pasting that stderr would get the DNS-bypass finding ahead of the one
saying a 403 on CONNECT is a policy denial and not an outage — the most
load-bearing entry in this corpus for this sandbox.

**The cause is the ranker, not these findings.** cairn-0001 scores 56.6 against
cairn-0029's 26.7, and loses anyway: ordering comes from RRF across four
rankers and RRF discards magnitude, so a candidate with 2.1x the score can be
outvoted on position. Neither draft does it alone — with either one removed,
cairn-0001 leads — so bisecting one commit at a time would never have found it,
and neither draft shares any vocabulary with a proxy 403.

They are parked rather than admitted because a red test that predates the
change is a stop, not a floor to move; and rather than fixed in the same pass
because the fusion weights were each measured against both suites, and
rewriting them in a hurry is how that gets quietly undone. Fix the fusion,
restore the floor to 5, then move these back.
