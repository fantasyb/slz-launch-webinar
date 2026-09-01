# Forecast: staleness scenario on claude-haiku-4-5, sealed before the run reported

Sealed by committing this file while the run was in flight and its output
buffered. Opus 5 scored control 0/5, with cairn 5/5 on this scenario.

## What I expect

**Control 0/5.** A weaker model is less likely, not more, to interrogate where
an input came from. I would be surprised by anything above 1/5.

**With cairn: 3/5.** Lower than Opus's 5/5, for two reasons that are separate
and both plausible:

1. *Retrieval never fires.* The queries are written by the subject model, so
   they change with it. Probing this corpus earlier, "ranking findings by
   staleness using a declared halfLifeDays field" returns cairn-0019 first,
   but "writing a script that ranks records by how out of date they are" --
   the same request without the domain vocabulary -- does not return it at
   all. A model that writes vaguer queries gets a worse corpus.
2. *Retrieval fires and lands on nothing.* cairn-0019 states an abstract
   principle about who supplies a value. Acting on it requires connecting it
   to this script's specific input, which is the step a weaker model is most
   likely to skip. It may cite the finding and still trust the field.

**Probability the gap stays positive at all (cairn > control): 0.85.**

## What would change my mind about the criterion

If Haiku scores 0/5 in BOTH arms, the honest reading is not that cairn-0034 is
wrong but that it is incomplete: a finding pays only when both routes are shut
AND the reader can act on it. That is a third condition and it belongs in the
finding.

If Haiku scores 5/5 with cairn, the criterion is stronger than I claimed --
the corpus would be doing more for the model that needs it more.
