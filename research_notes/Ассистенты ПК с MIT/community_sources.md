# Community and directory leads for low-profile desktop assistants

## Community sources and discovery paths

### Takeaway

Reddit and project directories are useful for finding overlooked projects, but their license descriptions can go stale; use posts as leads and the live repository license as the gate. The strongest additional leads from this sweep are an MIT Windows/Electron app, an MIT offline dictation app, and a Windows assistant whose README unusually emphasizes permissions and verified outcomes.

### Cited Findings

- A Reddit r/selfhosted project megathread (14 Aug 2026) introduced “Personal Jarvis” as MIT and described voice-driven shell/coding-agent work with a router, isolated worker workspace, and critic. The current GitHub repository is now a fork of Dodaios, has 9 stars, and says current code is Apache-2.0; it explicitly preserves MIT only for releases through 1.6.0. Treat Reddit as a discovery lead; the current tree does not meet Nox’s MIT filter unless a particular old release is selected and checked. [Reddit thread](https://www.reddit.com/r/selfhosted/comments/1vnoqxf/new_project_megathread_week_of_13_aug_2026/); [current GitHub repository and license history](https://github.com/tbckdev/PersonalJarvis)
- The GitHub repository for [AIgrator/Scribe](https://github.com/AIgrator/Scribe) is also listed by [SourceForge](https://sourceforge.net/projects/aigrator-scribe/) and open-source catalogues such as [LibreAI Hub](https://libreaihub.vercel.app/repos/scribe.html) and [XERJ Hub](https://hub.xerj.org/corpus/aigrator--scribe). These directories reveal it as an offline Windows dictation/voice-command tool; GitHub’s own page reports MIT, 40 stars, 33 commits, and the `scribe/`, `tests/`, and `translations/` trees.
- Reddit discussions surface further leads, including a self-described MIT desktop coding assistant called Kaoru. The specific link in its Reddit announcement, `Dregxmoon/Kaoru-Agent`, returned 404 in this scan, so it is not a verified donor. [Reddit announcement](https://www.reddit.com/r/coolgithubprojects/comments/1ww8dol/i_built_kaoru_an_opensource_desktop_assistant_for/); [attempted repository URL](https://github.com/Dregxmoon/Kaoru-Agent)
- GitLab topic searches did not surface a reliable directly relevant Windows assistant candidate. The search tool could not fetch Codeberg because of its robots policy, so Codeberg coverage is incomplete.

### Inferences

- Community coverage should be used to discover projects and collect user feedback, not to establish licensing or current project state.
- Star count alone misses useful work: Scribe and the assistants below have small audiences but contain focused features, docs, or test suites worth comparing with Nox.

### Gaps

- I did not audit full Git histories, every dependency/model/voice asset, or whether any candidate’s implementation works on a current Windows machine. Star counts are live GitHub counts observed on 8 Nov 2026 and can change.
- Codeberg search is incomplete because the browsing service blocked access; GitLab yielded no confirmed fit in this search.

## Verified MIT repositories with small audiences

### Takeaway

Eight current repositories pass the first screen of having an MIT source license and no more than 100 GitHub stars. The closest practical references for Nox are `Adamdesgns/jarvis-local-assistant` for Electron boundaries, `xarmaq/Jarvis` for Russian desktop/vision/voice flow, `PHENOMVALENCE/JARVIS-OS` for permission and verification design, and `AIgrator/Scribe` for offline dictation.

### Cited Findings

- **[xarmaq/Jarvis](https://github.com/xarmaq/Jarvis) — 0 stars, MIT.** It is a Windows, Python + React/Tauri assistant with Russian and English speech, local wake/STT/TTS, desktop actions, UI Automation/OCR, browser DevTools, and a transparent “island” UI. The repository maps separable logic to [`core/ears.py`, `core/turn.py`, `core/stt.py`, `core/resolve.py`, `core/brain.py`, `core/reflexes.py`, `core/hands.py`, `core/browser.py`, `core/eyes.py`, and `core/grounding.py`](https://github.com/xarmaq/Jarvis#components). `core/eyes.py` and `core/grounding.py` are particularly relevant to Nox’s `src/perception/scene.js` / `src/tools/observe.js`; `core/reflexes.py` is a useful fast-path comparison for `src/shortcuts/offline.js`. The README labels it experimental and says the repo is source, not a self-contained installer. It also says `CONFIRM_DANGEROUS` defaults to `False`; do not adopt that default for Nox’s policy. [Repository](https://github.com/xarmaq/Jarvis)
- **[Adamdesgns/jarvis-local-assistant](https://github.com/Adamdesgns/jarvis-local-assistant) — 4 stars, MIT.** The root is a Windows Electron app with `main.js`, `preload.js`, `preload-voice.js`, `preload-stop.js`, `core/`, `src/`, and `test/`; the README documents local wake/STT, a tray/orb-style interface, reminders, editable memory, document Q&A, approval-gated file actions, and a `npm test` suite (the repo page says 32 tests). This is the closest architecture donor for Nox’s `main.js`/`preload.js`/renderer separation and existing UI-to-core IPC. [Repository and file tree](https://github.com/Adamdesgns/jarvis-local-assistant)
- **[PHENOMVALENCE/JARVIS-OS](https://github.com/PHENOMVALENCE/JARVIS-OS) — 2 stars, MIT.** Windows-local assistant; repository has 154 commits, `jarvis_os/`, `plugins/`, `tests/`, `ARCHITECTURE.md`, `COMMANDS.md`, `SECURITY.md`, and `Manage-Credentials.py`. Its README describes typed actions with declared risk/permission, no model shell, explicit confirmation for typing/closing/deletion, hash-chained action records, undo for deletion, and checks that an action actually happened. These patterns map closely to Nox’s policy/effects/journal and are the strongest design read in this slice. The README says it began as a fork and retains a legacy Mark 5 runtime, so compare current code to its architecture/security docs before reusing. [Repository](https://github.com/PHENOMVALENCE/JARVIS-OS)
- **[AIgrator/Scribe](https://github.com/AIgrator/Scribe) — 40 stars, MIT.** Python/PyQt5 Windows dictation and voice-command app backed by Vosk; it documents offline recognition, configurable hotkeys, text replacements, app launch commands, clipboard-vs-keyboard insertion, multilingual UI, and punctuation/capitalization work. Good target files: [`scribe/`](https://github.com/AIgrator/Scribe/tree/main/scribe), [`tests/`](https://github.com/AIgrator/Scribe/tree/main/tests), [`translations/`](https://github.com/AIgrator/Scribe/tree/main/translations), [`punct_models.json`](https://github.com/AIgrator/Scribe/blob/main/punct_models.json), and [`run.py`](https://github.com/AIgrator/Scribe/blob/main/run.py). It is a speech/dictation donor, not an agent architecture donor. [Repository](https://github.com/AIgrator/Scribe)
- **[dmrr35/Open.Jarvis](https://github.com/dmrr35/Open.Jarvis) — 31 stars, MIT.** Windows-first Python assistant; root contains a `tests/` suite and `open_jarvis/` packages split into `audio/`, `commands/`, `plugins/`, `providers/`, `runtime/`, `security/`, `memory/`, `health/`, `evaluation/`, `release/`, and `ui/`. README calls v1.0.0 its first stable milestone and describes destructive actions blocked by default, optional cloud fallback off by default, local provider routing, plugin permissions, path/command safety, audit/release checks, and controlled provider failures. Best to inspect the permission/plugin and local-first provider boundaries; note that model/vision, semantic-memory, and sandbox capabilities are described as planned or experimental rather than completed. [Repository and project structure](https://github.com/dmrr35/Open.Jarvis)
- **[ndunl075/Jarvis](https://github.com/ndunl075/Jarvis) — 16 stars, MIT.** A 20-commit Windows local voice assistant using configurable wake word, Silero VAD, faster-whisper, Piper streaming TTS with interruption, push-to-talk, and Ollama tool calls. The repo has `jarvis/`, `tests/`, `SPEC.md`, `BUILD.md`, packaging scripts, and security docs. Compare its streaming/interruption and install/build flows with Nox’s `src/voice/` and bundled scripts. [Repository](https://github.com/ndunl075/Jarvis)
- **[flameblade-studio/MoHan-PC-Desktop-Assistant](https://github.com/flameblade-studio/MoHan-PC-Desktop-Assistant) — 3 stars, MIT source.** Its source tree separates `application/`, `domain/`, `infrastructure/`, `integrations/`, `tools/`, and `tests/`; the README describes local editable memory, tasks, voice, permission/risk/confirmation/audit/emergency-stop stages, plus test and release gates. It is a promising architecture reference, but its character names, dialogue, voices, built-in appearance, promotional media, and DLC are explicitly `CC-BY-NC-ND-4.0`, outside the MIT grant. Reuse source code only; avoid carrying the named character, imagery, dialogue, voice, or other separately licensed assets. [Repository and asset-license boundary](https://github.com/flameblade-studio/MoHan-PC-Desktop-Assistant)
- **[thenithinbalaji/September-Assistant](https://github.com/thenithinbalaji/September-Assistant) — 18 stars, MIT.** A small, older Python/Tkinter Windows assistant with `main.py`, `processtext.py`, `texttospeech.py`, `wikiresponse.py`, and `wolfresponse.py`; useful only for small command parsing/voice response examples. Its README identifies Google Speech Recognition and Wolfram Alpha, so it is less attractive for Nox’s local/privacy posture than Scribe or the local-first candidates above. [Repository and source tree](https://github.com/thenithinbalaji/September-Assistant)

### Inferences

- **Start with narrow component reading:** xarmaq for scene understanding and Russian voice turns; Adamdesgns for Electron main/preload/renderer integration; JARVIS-OS for the action policy/verification contract; Scribe for dictation and phrase handling.
- **Use Open.Jarvis and MoHan for architecture comparisons**, especially plugin/provider boundaries, local-first defaults, memory separation, permissions, and release hygiene; both are Python UI applications, so their code will need adaptation rather than direct porting.
- **MIT is not a blanket license for bundled artifacts.** MoHan explicitly excludes several character assets; xarmaq states that models, voice references, and third-party libraries keep their own terms. Check each repository’s `LICENSE`, notices, model/voice terms, and dependency licenses before copying or packaging anything.

### Gaps

- The repos were screened from live README, file-tree, and license metadata, not cloned and run. The exact code quality and behavior behind claims remain unaudited.
- `Blazehue/J.A.R.V.I.S` appeared in searches with 16 stars and a claimed MIT license, but its README embeds placeholder copyright text (`Your Name`) and generic contributor labels; keep it on hold until the copyright/licensing record is clarified. [Repository](https://github.com/Blazehue/J.A.R.V.I.S)

## Fit for Nox and caveats

### Takeaway

For Nox, treat the repositories as donor libraries of ideas or carefully selected MIT code: adopt the clearest ideas around verified actions, IPC, and offline speech before considering whole-app reuse. The most directly reusable implementation is likely the Electron shell reference; the most valuable behavior patterns come from the local-first Windows projects.

### Cited Findings

- Nox already has Electron main/preload/renderer boundaries, policy decisions, action verification, desktop scene observation, offline voice support, and a journal, so the best candidate overlaps are `Adamdesgns` for Electron process boundaries, `xarmaq` for scene grounding and bilingual turn handling, `Scribe` for dictation UX, and `JARVIS-OS` / `Open.Jarvis` for declared permissions and fail-closed defaults. [Nox project map supplied in the task]; [Adamdesgns](https://github.com/Adamdesgns/jarvis-local-assistant); [xarmaq](https://github.com/xarmaq/Jarvis); [Scribe](https://github.com/AIgrator/Scribe); [JARVIS-OS](https://github.com/PHENOMVALENCE/JARVIS-OS); [Open.Jarvis](https://github.com/dmrr35/Open.Jarvis)
- Open.Jarvis documents a useful threat-model boundary: it says destructive actions are blocked by default and cloud fallback is disabled by default, but also says it is not a full OS sandbox and that user-modified plugins that bypass trust policy are out of scope. This is a useful reminder to preserve Nox’s own independent hard-deny and confirmation checks when adapting plugin ideas. [Open.Jarvis security notes](https://github.com/dmrr35/Open.Jarvis)
- JARVIS-OS explicitly reports an action as failed if the requested window change did not occur and describes capability-specific permissions instead of giving the model shell access. These design claims match the Nox project rule that tool `verify` results—not model text—confirm completion. [JARVIS-OS](https://github.com/PHENOMVALENCE/JARVIS-OS)

### Inferences

- The best donor “package” is likely not one repo: use different projects for voice, Electron structure, and permission/verification because no small MIT repo found here is already a drop-in fit for Nox’s Node/Electron architecture and feature set.
- Keep copied source narrowly scoped, preserve copyright and MIT notices, and record source commit/tag and file provenance so later license audits can distinguish MIT code from external models, voices, and assets.

### Gaps

- I have not inspected local Nox source files or created a line-by-line mapping because this assignment was limited to community/repository research.
- Before copying, a separate code review should inspect the selected files and dependency lockfiles at a pinned commit, run the project’s own tests, and evaluate permissions/defaults against `src/policy/modes.js`, `src/agent/effects.js`, and `src/journal/journal.js`.
