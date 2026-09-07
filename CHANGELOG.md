# [0.8.0](https://github.com/cubicecho/agent-mcp-pool/compare/v0.7.2...v0.8.0) (2026-09-07)


### Features

* give a probe a timeout, defaulting to the pool's ([46a449a](https://github.com/cubicecho/agent-mcp-pool/commit/46a449ab1db81720ec5af8a91914f6e87456ff2d)), closes [#34](https://github.com/cubicecho/agent-mcp-pool/issues/34)

## [0.7.2](https://github.com/cubicecho/agent-mcp-pool/compare/v0.7.1...v0.7.2) (2026-09-07)


### Performance Improvements

* wake only the servers that could own the name ([b75d706](https://github.com/cubicecho/agent-mcp-pool/commit/b75d7069b523994c078a8516bb3124987be1e4b7))

## [0.7.1](https://github.com/cubicecho/agent-mcp-pool/compare/v0.7.0...v0.7.1) (2026-09-07)


### Bug Fixes

* close the client when a connect fails after the handshake ([73d0183](https://github.com/cubicecho/agent-mcp-pool/commit/73d018345285534f2b63b595d014b5ff7aa6fd6a)), closes [#22](https://github.com/cubicecho/agent-mcp-pool/issues/22)
* flush waits for the reconcile, not for the flag that one is owed ([12d8a19](https://github.com/cubicecho/agent-mcp-pool/commit/12d8a19f892463a12a16731fdfced026e8cc7061)), closes [#23](https://github.com/cubicecho/agent-mcp-pool/issues/23)

# [0.7.0](https://github.com/cubicecho/agent-mcp-pool/compare/v0.6.0...v0.7.0) (2026-09-07)


### Features

* state() reports the configured row, in the configured order ([47fb97e](https://github.com/cubicecho/agent-mcp-pool/commit/47fb97ec2dc404a8e583e9f9e773cc1e7b82e48c)), closes [#17](https://github.com/cubicecho/agent-mcp-pool/issues/17)

# [0.6.0](https://github.com/cubicecho/agent-mcp-pool/compare/v0.5.0...v0.6.0) (2026-09-07)


### Features

* default a server's slug to its id ([4ec04b7](https://github.com/cubicecho/agent-mcp-pool/commit/4ec04b7159dfd3992844050f457ec2b090203215)), closes [#18](https://github.com/cubicecho/agent-mcp-pool/issues/18)

# [0.5.0](https://github.com/cubicecho/agent-mcp-pool/compare/v0.4.0...v0.5.0) (2026-09-07)


### Features

* make the connection lifecycle a policy — lazy connect, idle reap ([058a23d](https://github.com/cubicecho/agent-mcp-pool/commit/058a23dfd8b5aba0e6454c6c2a1baa9d41137181))

# [0.4.0](https://github.com/cubicecho/agent-mcp-pool/compare/v0.3.0...v0.4.0) (2026-09-07)


### Features

* expose the connected client, past the agent-loop surface ([6dd8bf4](https://github.com/cubicecho/agent-mcp-pool/commit/6dd8bf43caef9dc532c10b733e823b78bce48ab8))

# [0.3.0](https://github.com/cubicecho/agent-mcp-pool/compare/v0.2.1...v0.3.0) (2026-09-07)


### Features

* stdio cwd, and a relay for server notifications ([bf8a5b3](https://github.com/cubicecho/agent-mcp-pool/commit/bf8a5b3252f1341af996aafa23e752dec9156cb9))

## [0.2.1](https://github.com/cubicecho/agent-mcp-pool/compare/v0.2.0...v0.2.1) (2026-09-07)


### Bug Fixes

* keep a ready server with no tools out of the catalogue ([98282ff](https://github.com/cubicecho/agent-mcp-pool/commit/98282ffe6aa16b616a65d0d516bc60ff407a9064))

# [0.2.0](https://github.com/cubicecho/agent-mcp-pool/compare/v0.1.0...v0.2.0) (2026-09-07)


### Bug Fixes

* keep over-long tool names distinct instead of colliding ([d0869ba](https://github.com/cubicecho/agent-mcp-pool/commit/d0869ba4a3a7d5961eeeb7ab669da3c543bef60f)), closes [#5](https://github.com/cubicecho/agent-mcp-pool/issues/5)
* skip the prepare build in trees that cannot build ([ab35618](https://github.com/cubicecho/agent-mcp-pool/commit/ab356188cce35dba55d84e3137a805def4b1d775))


### Features

* let the pool probe, so a consumer names itself once ([9550b4c](https://github.com/cubicecho/agent-mcp-pool/commit/9550b4c0af3b507290b55bc7e962dcfa7545f9d0)), closes [#3](https://github.com/cubicecho/agent-mcp-pool/issues/3)
