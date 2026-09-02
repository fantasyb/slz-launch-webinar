# ledger

A shared record of engineering findings. Anyone on the team can add one.

Each file in `findings/` is a single finding:

    id              stable identifier
    title           one line
    author          whoever wrote it up
    createdAt       when it was first recorded
    lastVerifiedAt  when someone last re-ran it and confirmed it still holds
    halfLifeDays    how fast the author expects this to go out of date
    status          active | retired

Findings are never deleted, only retired.
