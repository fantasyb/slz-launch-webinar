# Forecast: the first pilot outside this repository

Sealed by committing before anyone outside this session has used Cairn.

## The event that has never happened

One finding carrying a `tool` trigger, recorded by an agent that is not this
repository's `claude-opus-5`, on an MCP server somebody actually uses — and
then served to a later session on that tool's description or result, with the
delivery visible in the ledger under `mcp-proxy:*`.

One occurrence settles it. Everything measured so far is one model, on one
machine, about traps its own author planted, and no finding in the corpus
carries a `tool` trigger at all. The proxy has only ever met a fixture.

## What I expect, over fourteen days, one organisation, one MCP server

**At least one qualifying finding recorded: 0.6.**

Reasoning for the number rather than an adjective. In the only unprompted
run (`data/harvest-records.json`), agents offered a record tool with the
requirement stated in its description produced findings on two of four
tasks — but both traps were public knowledge, which the corpus's own
admission criterion says should not have been recorded. Real MCP work has
the opposite property: the surprises are private, undocumented and
recurring, which is the half that pays. Against that, the writer must
notice, and noticing is the weakest link in every measurement so far.

**A second session then served that finding: 0.45.**

Lower than the first, and not because delivery is unreliable — it is the one
mechanism that has been verified end to end. It is lower because it requires
the same tool to be reached twice by different sessions inside the window,
and a trap learned once tends not to be hit again by the person who learned
it. This is the number most likely to fail for a boring reason.

**A finding whose check discriminates: 0.3.** Four of nineteen in the
hand-written corpus, four of six when the tool description stated the
requirement. For an MCP trap, reproducing it usually needs the connector, so
most will honestly be `manual: true` and fall outside the gate.

## What falsifies the premise rather than disappointing it

**Zero findings with a `tool` trigger from anyone else in fourteen days**,
with the proxy installed and working and the agents doing real work on that
server. Not "the pilot was too short" — fourteen days of daily use is the
window this was designed for, and if nothing is written in it, the writer
half does not transfer outside the repository that contains the instruction.
That is the premise the whole design rests on and it would be wrong.

The second falsification is quieter and worse: **findings recorded, none
ever served.** That would mean the corpus grows and nothing comes back,
which is a diary, and a diary is what people already have.

## What I am not measuring, stated so it cannot be claimed later

Whether the findings are any good. Whether anyone would pay. Whether the
proxy is better than a client feature that does not exist yet. A pass here
establishes that a second party's agents write about their own tools and
that the delivery path reaches them — nothing more, and that is already more
than this project has ever had.

## Instrumentation that must be true before day one

- Pilot findings land in their own corpus directory, never `cairn/`, or they
  enter the held-out suite and the guard's numbers become evidence of
  adoption. That is the ledger mistake in its next costume.
- A second signing identity on a second machine. A keypair minted by this
  session is not a person.
- `mcp-proxy:*` rows are the delivery evidence; `cli:find` rows are not.
