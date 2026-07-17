# Resetting Mort

Start over from nothing: no memory, no pages, no index, and a watcher that
resends everything.

Mort's state lives in **four** places, and they only make sense together. A
half-reset is worse than no reset, because he comes back up believing things
that are no longer true:

| Where | Holds | Cleared by |
|---|---|---|
| Postgres (`mort_*`) | Everything he learned, decided, and holds | `scripts/reset-mort.ts` |
| Outline | The pages he wrote | `scripts/reset-mort.ts` |
| Qdrant | The search index over those pages | step 2, by hand |
| Watcher SQLite | Which files it has already sent | step 3, by hand |

The classic failure is clearing memory but not Outline. Mort's registry is what
stops him duplicating a page — wipe it while the pages live on and the next
ingest writes a second copy of everything, right next to the first.

Run the steps in order. All of it is destructive and none of it is reversible.

---

## 1. Postgres + Outline

Dry-run first. It changes nothing and prints every page and row it would destroy:

```bash
cd avops-assistant
docker compose exec ingest npx tsx scripts/reset-mort.ts
```

Read the list. Then:

```bash
docker compose exec ingest npx tsx scripts/reset-mort.ts --yes
```

It deletes the Outline pages **before** truncating the tables, because
`mort_docs` is the only record of which pages are Mort's. If any page fails to
delete it stops and leaves the tables alone, rather than orphaning pages that
nothing remembers he made.

## 2. Qdrant

The assistant owns the index; the ingest service can't reach it. Both collections
are recreated automatically on next use, so deleting them is safe:

```bash
docker compose exec qdrant sh -lc '
  for c in ilumina_kb ilumina_events; do
    curl -s -X DELETE "http://localhost:6333/collections/$c" && echo " <- $c"
  done'
```

Skipping this leaves the chat citing pages that no longer exist.

## 3. The watcher (on the OneDrive PC)

The manifest is how the watcher knows what it has already sent. Until it's gone,
it thinks every file is done and sends nothing.

Stop the watcher, then delete its manifest:

```bat
del "%LOCALAPPDATA%\mort-watcher\manifest-*.sqlite"
```

(One file per watched folder, keyed by a hash of the path — the wildcard clears
all of them. It lives in `LOCALAPPDATA`, deliberately outside OneDrive, so it
never syncs.)

## 4. Bring Mort back

`mort_settings` is gone, so the mode has reverted to the `MORT_MODE` env default
— which is `off` unless your compose says otherwise. Nothing will happen until
you set it.

Start in **shadow** and read the proposals before letting him write:

```bash
curl -s -X POST http://localhost:3001/mort/config \
  -H "Authorization: Bearer $INGEST_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"shadow"}'
```

Or use the mode switcher on `/admin/mort`.

Then restart the watcher. It finds an empty manifest, treats every file as new,
and resends the folder. Watch it land on `/admin/mort` — the activity panel shows
what he's working through and what he decides about each file.

Once the proposals look right, switch to `live`.

---

## What you'll see afterwards

The first run through a corpus is the worst case for Mort's judgement: early
files are decided when he knows almost nothing, so expect more `HOLD`s at the
start than at the end. That's the design working — he files what he can't place
yet and re-checks it once a page it belongs on appears.

If you want him to take stock once the dust settles, make him dream:

```bash
curl -s -X POST http://localhost:3001/mort/dream \
  -H "Authorization: Bearer $INGEST_API_KEY"
```

That's the pass that asks what no single file can: what's missing, what
contradicts, what should merge.
