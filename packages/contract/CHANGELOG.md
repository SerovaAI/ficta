# @serovaai/ficta-contract

## 0.3.0

### Minor Changes

- [`5cd450f`](https://github.com/SerovaAI/ficta/commit/5cd450f06b3e6e6c57c83df919d0e8d7b559c428) Thanks [@steflsd](https://github.com/steflsd)! - Bring engine policies and roster validation into the proxy, replace unknown Gateway response references before delivery, and persist restoration counts with active-registry fingerprints.

- [`2275437`](https://github.com/SerovaAI/ficta/commit/2275437e1e3ea4099316a9fd96fd37e726820866) Thanks [@steflsd](https://github.com/steflsd)! - Make permanent removal of detected categories an opt-in setting editable from the control plane (`destroyCategories`, mapped to `dispositions.destroy.categories`; `"*"` stays TOML/env-only and locks the field), and turn it off in the Gateway reference deployment so detected values are restored by default.

### Patch Changes

- Updated dependencies [[`5cd450f`](https://github.com/SerovaAI/ficta/commit/5cd450f06b3e6e6c57c83df919d0e8d7b559c428), [`2275437`](https://github.com/SerovaAI/ficta/commit/2275437e1e3ea4099316a9fd96fd37e726820866)]:
  - @serovaai/ficta-protocol@0.9.0

## 0.2.4

### Patch Changes

- Updated dependencies []:
  - @serovaai/ficta-protocol@0.8.0

## 0.2.3

### Patch Changes

- Updated dependencies []:
  - @serovaai/ficta-protocol@0.7.0

## 0.2.2

### Patch Changes

- Updated dependencies []:
  - @serovaai/ficta-protocol@0.6.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`ac2aeb3`](https://github.com/SerovaAI/ficta/commit/ac2aeb37b379070826e814cca59568011bc0a1ef)]:
  - @serovaai/ficta-protocol@0.5.0

## 0.2.0

### Minor Changes

- [`3916323`](https://github.com/SerovaAI/ficta/commit/3916323c51e6652e726cdb7ce905b590e0ac9ca5) Thanks [@steflsd](https://github.com/steflsd)! - Publish discoverable evidence and operator interfaces with validated clients and portable preview tickets.

### Patch Changes

- Updated dependencies [[`6936247`](https://github.com/SerovaAI/ficta/commit/6936247f99455448eaa5b52737d64c7b72961cef)]:
  - @serovaai/ficta-protocol@0.4.0

## 0.1.0

### Minor Changes

- [#93](https://github.com/SerovaAI/ficta/pull/93) [`beea199`](https://github.com/SerovaAI/ficta/commit/beea19913006cd482a3e62557966d535ff4ee2b2) Thanks [@steflsd](https://github.com/steflsd)! - Publish and serve a versioned oRPC/OpenAPI control-plane contract for third-party Ficta frontends.

### Patch Changes

- Updated dependencies [[`ef4f682`](https://github.com/SerovaAI/ficta/commit/ef4f6828037221f3448c0f4088657922f5285424), [`b87273c`](https://github.com/SerovaAI/ficta/commit/b87273cb732351bf0e648091f5e10d91f1847f78)]:
  - @serovaai/ficta-protocol@0.3.0
