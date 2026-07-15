**Design QA**

- Source visual truth: `C:\Users\USER\AppData\Local\Temp\codex-clipboard-d9a54dec-8e90-42e0-bc6a-6a2508b94e98.png`, `C:\Users\USER\AppData\Local\Temp\codex-clipboard-f3bc2b29-c3ef-4aaf-9915-b8f6dbda4281.png`, `C:\Users\USER\AppData\Local\Temp\codex-clipboard-a8fadff7-db14-4158-a2e6-04ed5e422057.png`, and `C:\Users\USER\AppData\Local\Temp\codex-clipboard-0551bec5-c63e-4735-95a0-3e737d85e416.png`
- Implementation screenshot: unavailable; Windows capture returned a different application window for the selected Milim handle
- Viewport: desktop, Git inspector with the diff-scope menu open
- State: dark theme, custom scope selector, left file navigator, narrow diff toolbar

**Full-view comparison evidence**

The sources showed the native Windows select menu breaking the app-styled surface, the hide-files control detached from its context, the search field overlapping the diff summary at a narrow width, and the review body floating inside a second card with Agent review stranded below it. The native selects were replaced with Milim's existing checked context-menu pattern, the hide control was moved next to the scope selector when collapsed, the toolbar now wraps before controls can overlap, Agent review moved into the repository action row, and the review body now fills the inspector edge to edge. A post-fix Milim capture could not be obtained.

**Focused region comparison evidence**

The scope-control and narrow-toolbar regions are readable in the supplied focused screenshots. Post-fix focused evidence is blocked by the capture mismatch.

**Findings**

- [P1] Native diff selectors did not match Milim's visual language. Fixed in code by reusing the existing app context menu for scope, commit, and branch choices.
- [P1] Search could overlap the scope summary. Fixed with container-based wrapping at 760px and 520px.
- [P2] The file navigator toggle was detached from the surface it controls. Fixed by placing Hide files in the Changes header and showing the restore control only while hidden.
- [P1] The diff workspace read as a floating card rather than the inspector body. Fixed by removing the outer inset, radius, and side borders while retaining the file/diff divider.
- [P2] Agent review was visually disconnected below the main workflow. Fixed by moving it into the repository action row.
- [P2] Post-fix visual fidelity is unverified because the selected Milim window could not be captured reliably.

**Comparison history**

- Initial finding: native operating-system dropdown was visually inconsistent.
- Fixes: replaced both native selects with app-styled menu triggers, relocated the file toggle contextually, added collision-safe toolbar wrapping, moved Agent review into the header, and flattened the review body into the inspector.
- Post-fix evidence: blocked by the window-capture mismatch.

**Implementation checklist**

- Confirm the scope menu uses the app context-menu surface.
- Confirm Commit and Branch open the same styled surface.
- Confirm the Changes header owns the Hide files control.
- Confirm the search field wraps without overlapping the scope summary.
- Confirm checked, disabled, hover, and keyboard-focus states are visible.

final result: blocked
