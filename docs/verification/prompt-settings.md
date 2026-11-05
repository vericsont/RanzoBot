# Prompt settings

Settings → AI / Model providers → Bot instructions exposes two workspace-wide
editors: the shared bot reply instructions and the OpenCode build-agent prompt.
Each has its own Save and Reset to default. Changes apply to the next turn;
existing tool-specific guidance, authorization and permission enforcement stay
in place. OpenCode's other agents, project instructions and plugins may add
instructions. The editors are available to workspace admins only.

```sh
pnpm exec vitest run src/components/PromptSettings.test.ts src/components/SettingsModal.simple.test.ts server/admin-activity.test.ts server/workspace-backup-policy.test.ts server/bot-continuity.e2e.test.ts server/cloud-team-admin.e2e.test.ts
OMB_OPENCODE2_E2E_CLI=/absolute/path/to/opencode pnpm exec vitest run server/opencode-copilot-efforts.e2e.test.ts
```

The isolated fake-engine fixture checks saving, limits, disk persistence, the
bot prompt preview, direct and room dispatch, retained safety instructions and
reset. The Team Cloud fixture checks that a member cannot edit or read the
settings, and that the activity log never keeps prompt text. The optional
OpenCode fixture checks an existing conversation after editing and after reset,
with a synthetic loopback provider. Component tests check edits, reset and
errors in both settings modes. The real settings modal was also mounted against
a disposable fake-engine server at 1440×900 and 390×844: each editor was saved
and reset through the browser, the API confirmed both changes, and the browser
reported no errors. This preview did not mount the complete app or exercise
Electron. None of these establish that a real model will follow the instructions.
