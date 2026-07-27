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
| Qdrant + `kb_documents` | The search index over those pages | **Clear index** on `/admin` |
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

## 2. The index

On `/admin`, click **Clear index** (twice — it asks). That drops both Qdrant
collections and forgets every indexed document and sync run. Everything it drops
is derived from Outline, so a re-sync rebuilds it.

Skipping this leaves the chat citing pages that no longer exist.

**Re-sync alone is also enough now**, but it wasn't before: `fullSync` skipped
its prune step whenever it saw zero documents, so emptying Outline and hitting
*Re-sync now* left the entire index in place — the KB kept reporting documents
that no longer existed. Fixed; an empty Outline now prunes everything. **Clear
index** remains the surer path, because it recreates the collections clean
rather than emptying them point by point.

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

Use the mode switcher on `/admin/mort` — the ingest service publishes no host
port, so there's nothing to curl from the host. (`localhost:3001` is the
*assistant*.) If you'd rather do it from a shell:

```bash
docker compose exec ingest node -e "fetch('http://localhost:'+process.env.PORT+'/mort/config',{method:'POST',headers:{Authorization:'Bearer '+process.env.INGEST_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({mode:'shadow'})}).then(r=>r.text()).then(console.log)"
```

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

Once the dust settles, make him dream. The ingest service publishes no host
port, so go through the container (or the tunnel hostname):

```bash
docker compose exec ingest node -e "fetch('http://localhost:'+process.env.PORT+'/mort/dream',{method:'POST',headers:{Authorization:'Bearer '+process.env.INGEST_API_KEY}}).then(r=>r.text()).then(console.log)"
```

A dream does two things: re-checks every artifact still held with nowhere to go
(this is what actually gets files attached once their pages exist), and asks what
no single file can — what's missing, what contradicts, what should merge.

**Re-sync the KB index first.** Mort finds pages to attach to via `kb_search`,
which reads Qdrant. A page that exists in Outline but isn't indexed is invisible
to him, so he'll hold the file again and the dream will have been for nothing.
