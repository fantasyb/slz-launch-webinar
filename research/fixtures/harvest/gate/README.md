# review-gate
Runs our adversarial review over the files a pull request changes. The workflow
checks out the base commit so the tooling comes from trusted code, then copies
the PR's files in.
