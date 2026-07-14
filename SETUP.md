# Setting up sealed-migrations from scratch

A complete first-time recipe: from an empty project to a working migration setup,
including the pieces `sealed-migrations` deliberately does not ship (a thin CLI
wrapper, a scaffolder, the baseline, the branch guard, CI, and deploy wiring). The
package is the engine; you own the small amount of glue below.

Already have a project with its own vendored migration script? Use
[MIGRATING.md](./MIGRATING.md) instead (it reuses most of the artifacts here).

## 1. Install

```bash
pnpm add sealed-migrations mysql2 dotenv
```

## 2. The wrapper

Create a thin CLI wrapper at a stable path, e.g. `scripts/db/db-migrate.mjs`. It
resolves env and the driver, then hands the command to the runner. Copy
[`examples/basic-wrapper.mjs`](./examples/basic-wrapper.mjs) (single-writer
MySQL/MariaDB) or [`examples/mariadb-cluster-wrapper.mjs`](./examples/mariadb-cluster-wrapper.mjs)
(MariaDB on a cluster: adds a server-type check and a deadlock retry) and adjust the
env names and lock name.

Three config fields matter for correctness:

- **`databaseName`** (required): enables the baseline short-circuit. Omit it and the
  first run against an already-populated schema executes the baseline SQL and fails.
- **`appVersion`** and **`executedBy`**: recorded in `schema_migrations`, so releases
  are traceable. Wire them to your CI SHA and hostname.

## 3. package.json scripts

```json
{
  "scripts": {
    "migrate:up": "node ./scripts/db/db-migrate.mjs up --allow-dev",
    "migrate:down": "node ./scripts/db/db-migrate.mjs down",
    "migrate:current": "node ./scripts/db/db-migrate.mjs current",
    "migrate:status": "node ./scripts/db/db-migrate.mjs status",
    "migrate:seal": "node ./scripts/db/db-migrate.mjs seal",
    "migrate:rehash": "node ./scripts/db/db-migrate.mjs rehash",
    "migrate:new": "./scripts/db/new-migration.sh"
  }
}
```

`migrate:up` passes `--allow-dev` for local dev; production paths (step 7) call `up`
without it, so an unsealed migration cannot deploy.

## 4. The scaffolder

The package runs migrations; it does not create them. Add
`scripts/db/new-migration.sh` (creates `dev_<slug>/` by default, `--numbered` for a
hotfix straight on a protected branch):

```bash
#!/usr/bin/env bash
set -euo pipefail

slugify() {
  if command -v node >/dev/null 2>&1; then
    RAW="$1" node -e "process.stdout.write((process.env.RAW||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,''))"
  else
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '_' | sed 's/^_//; s/_$//'
  fi
}

NUMBERED=0
RAW_DESC=""
for arg in "$@"; do
  case "$arg" in
    --numbered) NUMBERED=1 ;;
    *) RAW_DESC="$arg" ;;
  esac
done
[ -n "$RAW_DESC" ] || read -r -p "Migration name: " RAW_DESC

DESC="$(slugify "$RAW_DESC")"
[ -n "$DESC" ] || { echo "Description must contain at least one alphanumeric character." >&2; exit 1; }

mkdir -p migrations
if [ "$NUMBERED" = "1" ]; then
  MAX="$(find migrations -mindepth 1 -maxdepth 1 -type d -name '[0-9]*_*' -exec basename {} \; | sed -E 's/^([0-9]+)_.*/\1/' | sort -n | tail -n 1)"
  NEXT="$(printf '%03d' $((10#${MAX:-0} + 1)))"
  VERSION="${NEXT}_${DESC}"
else
  VERSION="dev_${DESC}"
fi

TARGET="migrations/${VERSION}"
[ -d "$TARGET" ] && { echo "Migration ${VERSION} already exists." >&2; exit 1; }
mkdir -p "$TARGET"
printf -- '-- migrate: auto\n' > "$TARGET/up.sql"
printf -- '-- migrate: auto\n' > "$TARGET/down.sql"
echo "Created migration: ${VERSION}"
[ "$NUMBERED" = "0" ] && echo "Apply with: pnpm migrate:up; seal before merge: pnpm migrate:seal ${DESC}"
```

`chmod +x scripts/db/new-migration.sh`.

## 5. The baseline

The first migration must be `001_baseline` (or your configured `baselineVersion`).

- **Empty database:** put your initial schema in `001_baseline/up.sql` and a matching
  `down.sql`. It runs like any migration.
- **Adopting an existing (populated) database:** dump the current schema into
  `001_baseline/up.sql` (e.g. `mysqldump --no-data`) with a `-- migrate: no-tx` first
  line, and a no-op `down.sql` (`SELECT 1;`). On the first run the runner detects the
  existing tables (via `databaseName`) and records the baseline as applied
  (`baseline_mark`) **without executing it**, so it is never applied twice.

Every later migration is created with `migrate:new` and sealed before merge.

## 6. The branch guard

Keep unsealed `dev_*` folders off your protected branches. Add
`scripts/db/check-dev-migrations.sh` (POSIX sh, branch-aware):

```bash
#!/usr/bin/env bash
set -eu

branch="${CI_COMMIT_BRANCH:-}"
if [ -z "$branch" ]; then
  branch="$(git branch --show-current 2>/dev/null || true)"
fi

# Set your protected branches here (integration branch + deploy branch).
case "$branch" in
  main|production) ;;
  *) exit 0 ;;
esac

found=""
for dir in migrations/dev_*/; do
  [ -d "$dir" ] && found="$found $dir"
done

if [ -n "$found" ]; then
  echo "Unsealed dev migrations are not allowed on ${branch}:${found}" >&2
  echo "Seal them first: pnpm migrate:seal <slug>" >&2
  exit 1
fi
```

Wire it into CI (GitLab example) so it gates the build:

```yaml
check_no_dev_migrations:
  stage: tests
  only: [main, production]
  script:
    - sh scripts/db/check-dev-migrations.sh
# add "check_no_dev_migrations" to the build/deploy job's `needs`
```

And into a pre-commit hook (lefthook example) for local branches:

```yaml
pre-commit:
  commands:
    dev-migrations-guard:
      run: bash scripts/db/check-dev-migrations.sh
```

## 7. Deploy and Docker

- Run migrations in your deploy step and/or container entrypoint with a **strict**
  `up` (no `--allow-dev`), so an unsealed migration fails the migrate step before any
  service starts:

  ```bash
  node ./scripts/db/db-migrate.mjs up
  ```

- Make sure the runtime / migrate image ships `node_modules/sealed-migrations`
  (zero runtime deps, but it must be present, alongside `mysql2` / `dotenv`). If your
  image copies a pruned set of files, add the package to the `COPY`.

## 8. Daily workflow

`migrate:new` a `dev_<slug>` → edit `up.sql` / `down.sql` → `migrate:up` → iterate
(`migrate:down` + `migrate:up`, or `migrate:rehash <slug>` after a manual change) →
`migrate:seal <slug>` right before merge → commit the renamed `NNN_<slug>` folder. See
the [README](./README.md) for the lifecycle, parallel-branch rules, and file format.

## 9. Verify

On a throwaway database (distinct name, scratch `--migrations-dir`), confirm: the guard
refuses `up` without `--allow-dev`; apply order is numbered-then-dev; a foreign `dev_*`
warns and shows as `FOREIGN`; a checksum mismatch aborts `up`/`status`, `rehash` fixes
it, `down` tolerates it; `seal` skips an in-use number, renames, and updates the row.
Run it against every DB engine you deploy to. Never touch a real database.
