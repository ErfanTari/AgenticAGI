# Phase 25.4 — Artifact-Class Engines and the Audit Framework

> **Audit question that motivated this doc:** "If I tell the agent to download
> a software installer or clone a GitHub repo for topic X, would it do the
> right thing? How do we stress-test that?"
>
> **Answer:** Not today, and the right fix is **separate engines per artifact
> class**, not a smarter generic engine. This document defines the classes,
> the per-class validators, the stress-test corpus, and the routing changes.

---

## 1. Why one engine cannot do all downloads

The Phase 24 `web_download_multi_target` engine is excellent at one thing:
**finding and validating PDFs of named documents from search engines**. It is
the wrong tool for:

| Artifact class | Why generic web-download fails |
|---|---|
| **Software installer** (.dmg/.exe/.deb) | Not a PDF — file-type filter rejects everything. Even if extension filter is widened, validation is wrong: an installer needs checksum/signature verification, not "is parseable PDF" |
| **GitHub repository** | Not a download at all — needs `git clone` (or `git ls-remote` + tarball download for snapshots). Verification is "does the cloned tree contain expected files / tags / commits", not file-size checks |
| **npm/pip package** | Should bypass web search entirely and hit the registry directly. Validator is "exists in registry, version satisfies range, hashes match lockfile" |
| **Docker image** | Pull from registry; verify by digest. No web search at all |
| **API export** (CSV, JSON dump) | Already covered by `api_paginated_collect` — but not by web download |
| **Video/audio file** | Validator is "valid container + duration > N seconds" via ffprobe |

The pattern: **each artifact class has its own search strategy, source-of-truth,
and validator.** Trying to generalize one engine across all of them collapses
into either:

- A loop with LLM judgment at every step ("is this the right kind of file?") —
  which is exactly what the One-Call Engine architecture rejects, OR
- A validator that accepts everything that has the expected file extension —
  which is what produced the orphan PDFs the user found in
  `workspace/Porcelain_PDF/catalogs/` (a school art curriculum, an email
  exported via Chrome, a personal portfolio)

## 2. The artifact-class taxonomy

The Phase 25.3 `engineRegistry` ships with these concrete engines:

| Engine | Spec discriminant | Search strategy | Source-of-truth | Validator |
|---|---|---|---|---|
| `web_download_multi_target` (Phase 24) | `kind: 'web_download_multi_target'` | Brave search + page fetch + link extraction | Vendor sites; banned: flipbook hosts | Size + parse + content-text contains brand name AND artifact keyword |
| `file_batch_transform` (Phase 25.1) | `kind: 'file_batch_transform'` | None — operates on workspace files | The workspace itself | Per-record bytes-match / extension / source-still-exists |
| `api_paginated_collect` (Phase 25.2) | `kind: 'api_paginated_collect'` | None — direct API GETs | The endpoint | Per-record `requireFields` + dedupBy |
| **`software_install` (Phase 25.4 — new)** | `kind: 'software_install'` | Vendor domain → official downloads page → installer URL with arch suffix | Vendor allowlist + GPG/signature check | Checksum match + binary signature valid |
| **`repo_fetch` (Phase 25.4 — new)** | `kind: 'repo_fetch'` | Direct: `git ls-remote` against the URL | The git server | Tree contains expected files / branch / tag |

The principle from the whitepaper holds: **the registry, not the LLM, decides
which artifact classes exist.** The LLM only picks WHICH spec to emit, then
the engine takes over.

## 3. The content-truth lesson

The orphan PDFs proved a structural insight: **a validator that only checks
file shape will accept anything of the right shape.** Real-world web search
returns a stream of garbage that happens to be the right shape:

| File the engine accepted before fix | What it actually was |
|---|---|
| `Living_Ceramics_generalcatalog.pdf` (318KB) | "25_26 Art only 4yr Roadmap Freshmen" by Melissa Ledesma — a high school art curriculum exported from Excel via macOS Quartz |
| `Sapiens_Stone_generalcatalog.pdf` (2.5MB) | A personal portfolio by Michelle Yates |
| `Neolith_generalcatalog.pdf` (27MB) | "Mail - Ben - Outlook" — someone's email exported via Chrome → Skia/PDF |

All three were structurally valid PDFs of plausible size. The validator said
"yes". The content was garbage.

**Fix shipped in this phase:** `validatePdf` now optionally takes
`{ target, artifact }` and runs `checkContentRelevance` on the extracted text.
The PDF must mention the brand name AND a recognizable artifact keyword
(catalog, brochure, datasheet, etc.) in the first 20k chars. See
`core/skills/web-download-multi-target.ts` `checkContentRelevance`.

**Generalization for future engines:** every artifact-class engine needs a
content-truth validator distinct from its shape validator.

| Engine | Shape validator | Content-truth validator |
|---|---|---|
| `web_download_multi_target` | size ≥ minBytes, parses as PDF | brand name + artifact keyword in extracted text |
| `software_install` | file is signed, ABI matches host | binary version output matches expected, vendor signature valid |
| `repo_fetch` | git tree exists, default branch checks out | tree contains README, expected paths, expected tags |

## 4. Orphan cleanup

A second structural lesson: **failed validation must not leave artifacts on
disk**, because:

1. They pollute the workspace and confuse the user.
2. With `overwrite: 'if-missing'` semantics, a future run will SKIP the
   download because the file already exists, and never replace the bad file.
3. They conflate "attempted but failed" with "succeeded" in any post-hoc
   filesystem audit.

**Fix shipped in this phase:** `cleanupFailedDownload(filePath)` is called
unconditionally on every validation failure inside the engine loop. It is
workspace-sandboxed (refuses to unlink anything outside `PATHS.workspace`) and
emits a `web_download_validation_failed` transparency event with
`{ removed: bool }` so the operator can see what happened.

## 5. The audit framework — stress-test corpus

A behavior-focused test suite that audits the engine against adversarial
inputs. The corpus lives in
`tests/phase-25/web-download-stress-corpus.test.ts` and grows whenever a real
user reports a bad download.

Each entry encodes:

```
{
  name:         'the school curriculum case',
  userGoal:     'Download Living Ceramics 2025 catalog PDF',
  searchHits:   [<URLs the engine would see>],
  pdfTexts:     {<url> → <fake extracted text>},
  expected: {
    status:       'rejected',
    reason:       /content_mismatch.*Living Ceramics/,
    fileOnDisk:   false,    // orphan cleanup must run
  },
}
```

The harness drives `runWebDownloadMultiTarget` directly with mocked skills
and asserts the engine's outcome matches. There is no LLM in this loop — it
audits the deterministic decision logic, not the spec extractor.

**Adversarial cases currently in the corpus:**

| Input | Expected behavior | Why |
|---|---|---|
| School curriculum PDF for "Living Ceramics" | Rejected: brand mismatch | Real-world failure case from user's workspace |
| Email-as-PDF for "Neolith" | Rejected: brand mismatch | Real-world failure case |
| Personal portfolio for "Sapiens Stone" | Rejected: brand mismatch | Real-world failure case |
| Real catalog with brand on cover | Accepted | Sanity (don't over-reject) |
| Catalog with brand as compound (`SapiensStone` for `Sapiens Stone`) | Accepted | Real catalogs use both spellings |
| Article mentioning brand but no catalog keyword | Rejected: no artifact keyword | Press releases / blog posts |
| Generic "art supplies catalog" with no brand | Rejected: brand not found | Adversarial filename collision |
| First candidate is junk, second is real | Accepted on second try | Engine must iterate, not give up |
| `download VS Code installer` (wrong artifact class) | Rejected: no PDF candidates | Proves engine refuses out-of-class tasks |
| `clone github repo` (wrong artifact class) | Rejected: no PDF candidates | Same |
| Cleanup attempts on `/etc/passwd`, `../../etc/`, missing files | All return false (no-op) | Sandbox guarantee |

**Adding a new case:** just append a `describe()` block. No fixtures, no
network, no LLM — purely deterministic.

## 6. Out of scope for this phase

- **`software_install` engine**: defined here, not yet implemented. Tracked as
  Phase 25.4.1.
- **`repo_fetch` engine**: defined here, not yet implemented. Phase 25.4.2.
- **Universal `TaskSpec<K, I>` runtime**: blocked on landing 25.4.1+25.4.2 so
  the registry has 5 examples to abstract from, not 3.

The discipline from the whitepaper holds: build concrete examples until the
shared spine is unambiguous, *then* abstract.

---

## Appendix A — How to add a new artifact-class engine

1. Add `<class>SpecSchema` to `core/schemas.ts` with `kind: z.literal('<class>')`.
2. Add path-field normalization for any workspace-relative paths in the spec
   (use `workspaceRelativePath` helper).
3. Implement `core/skills/<class>.ts` with:
   - Counter-driven main loop (no LLM in the loop)
   - Typed ledger for resumability
   - Shape validator + **content-truth validator**
   - **Orphan cleanup on validation failure**
   - Transparency events at every state transition
4. Implement `core/skills/<class>-spec-extractor.ts` (single LLM call,
   bounded token budget).
5. Add detection regex in `core/router/dedicated-engine-dispatch.ts`.
6. Add tests in `tests/phase-25/<class>.test.ts` AND adversarial cases to
   `tests/phase-25/<class>-stress-corpus.test.ts`.
7. Document the engine's source-of-truth and validator in §2 above.

## Appendix B — Symptoms that reveal a missing artifact-class engine

If you see any of these in production logs, you need a new engine:

- The dispatcher routes to `web_download_engine` but every search ranks 0
  candidates → the artifact isn't a document.
- Validation passes but the user reports "this isn't what I asked for" → no
  content-truth validator for this class.
- User is forced to specify a URL by hand for every run → no source-of-truth
  for this class (the engine has no idea where to look).
- The skill chain involves a non-HTTP protocol (git, registry API, docker
  daemon) → outside `web_download_multi_target`'s primitives.
