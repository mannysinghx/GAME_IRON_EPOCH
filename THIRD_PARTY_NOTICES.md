# Third-party notices

IRON EPOCH's own code is licensed under Apache-2.0 (see [LICENSE](LICENSE)). The production bundle built from
`apps/web` includes the following third-party packages. Each remains under its own license; the full license texts
ship inside each package in `node_modules` after `npm install`.

## Bundled at runtime

| Package | Version | License | Source |
| --- | --- | --- | --- |
| three | 0.180.0 | MIT | https://github.com/mrdoob/three.js |
| preact | 10.29.8 | MIT | https://github.com/preactjs/preact |
| @fontsource-variable/inter (Inter font files) | 5.3.0 | OFL-1.1 | https://github.com/rsms/inter · packaged by https://fontsource.org |
| @fontsource/jetbrains-mono (JetBrains Mono font files) | 5.3.0 | OFL-1.1 | https://github.com/JetBrains/JetBrainsMono · packaged by https://fontsource.org |
| @fontsource/chakra-petch (Chakra Petch font files) | 5.3.0 | OFL-1.1 | https://github.com/m4rc1e/Chakra-Petch · packaged by https://fontsource.org |

The fonts are licensed under the SIL Open Font License 1.1 (https://openfontlicense.org). They are bundled and
served by the host; the game makes no requests to font CDNs.

## Build and development tools (not shipped in the bundle)

| Package | Version | License | Source |
| --- | --- | --- | --- |
| vite | 7.3.7 | MIT | https://github.com/vitejs/vite |
| typescript | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| @types/three | 0.180.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |

All game art (terrain, units, structures, effects, icons) is procedural geometry written for this project and is
covered by the project license. There are no third-party image, audio or model assets.
