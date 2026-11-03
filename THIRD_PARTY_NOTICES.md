# Third-party attribution

The host-binding structure in `hooks/register.tsx` and the in-memory fixture structure in
`tests/fixtures/world.ts` follow examples from Anthropic's `code-modernization` plugin:

- [Host binding](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-modernization/hooks/register.ts)
- [In-memory test world](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-modernization/tests/fixtures/world.ts)

Those upstream examples are published under the Apache License, Version 2.0. A copy is included
in [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt). Their original license and attribution
remain applicable to any incorporated upstream material. The original context-handoff code is
licensed under the MIT License in [LICENSE](LICENSE).

The context-handoff files implement this plugin's handoff lifecycle and test fixtures, with
different operations, state, validation and resource paths. They are modified examples rather
than an unchanged distribution of the upstream plugin. The original pattern references remain
beside the relevant code.
