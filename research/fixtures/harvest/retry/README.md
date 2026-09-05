# upstream-client
Wraps a rate-limited vendor API. They send Retry-After on 429. We run 40 of
these workers, and the vendor has complained about traffic arriving in waves.
