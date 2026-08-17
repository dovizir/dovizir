# Releasing

## Licence: bump the BUSL Change Date — every release

BUSL-1.1 is **per version**, and each version converts on whichever comes first:

- the stated **Change Date**, or
- the **fourth anniversary of that version's first public distribution**.

The four years is a **ceiling, not a floor**. A Change Date left unchanged means
protection shrinks with every release, and once it passes, new work is published
under the Change License immediately:

| Shipped | Fixed date 2030-08-17 | Bumped at release |
|---|---|---|
| 2026 | 2030 (~4 yrs) | 2030 (4 yrs) |
| 2028 | 2030 (2 yrs) | 2032 (4 yrs) |
| 2030 | **already passed — GPL on publication** | 2034 (4 yrs) |

So, before tagging:

```sh
./scripts/bump-license-date.sh   # sets Change Date to today + 4 years
git add LICENSE && git commit -m "Licence: roll Change Date for <version>"
```

Notes:

- Earlier generations still convert on schedule. Act-1 contracts go GPL in 2030
  no matter what — protection always covers the newest work, which is where the
  acts roadmap puts the value.
- Old versions converting does not affect new ones: the copyright is ours, so
  later versions can ship under BUSL while earlier ones are GPL.
- Deployed contracts carry their SPDX header in the verified source, so each
  deployment is its own version with its own date.
