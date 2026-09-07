# [2.3.0](https://github.com/cubicecho/agent-mcp-pool/compare/v2.2.0...v2.3.0) (2026-09-07)


### Features

* report a real client version in the MCP handshake ([241fa1c](https://github.com/cubicecho/agent-mcp-pool/commit/241fa1cb8272b4c29aac9b11bdd9c6a98bbe97ce)), closes [#60](https://github.com/cubicecho/agent-mcp-pool/issues/60)

# [2.2.0](https://github.com/cubicecho/agent-mcp-pool/compare/v2.1.0...v2.2.0) (2026-09-07)


### Bug Fixes

* dial the server reconnect() names, even under lazy ([c47aa78](https://github.com/cubicecho/agent-mcp-pool/commit/c47aa784b85261e5eb88583730d9e77ef324db5c))


### Features

* add stop(), closing one server and keeping its row ([fe0ac93](https://github.com/cubicecho/agent-mcp-pool/commit/fe0ac93357b1476f9075c9efd38df080264cbd30)), closes [#58](https://github.com/cubicecho/agent-mcp-pool/issues/58)

# [2.1.0](https://github.com/cubicecho/agent-mcp-pool/compare/v2.0.0...v2.1.0) (2026-09-07)


### Features

* let a pool skip the tool listing on connect ([dc9d8ec](https://github.com/cubicecho/agent-mcp-pool/commit/dc9d8ec9fb0601317148882a4c740ebe330fc242)), closes [#56](https://github.com/cubicecho/agent-mcp-pool/issues/56)

# [2.0.0](https://github.com/cubicecho/agent-mcp-pool/compare/v1.0.0...v2.0.0) (2026-09-07)


* feat!: take tools()'s names and scope as one named object ([4ef8103](https://github.com/cubicecho/agent-mcp-pool/commit/4ef8103808082686143472afbb295a4cd721a8f6)), closes [#53](https://github.com/cubicecho/agent-mcp-pool/issues/53)


### BREAKING CHANGES

* `tools()` takes one options object. `tools(names, servers)`
becomes `tools({ names, servers })`; `tools()` with no arguments is unchanged.

# [1.0.0](https://github.com/cubicecho/agent-mcp-pool/compare/v0.10.0...v1.0.0) (2026-09-07)


* feat!: drop openai as a peer dependency ([8139e0a](https://github.com/cubicecho/agent-mcp-pool/commit/8139e0a564340468afe58bcb1f85df7090f618e2)), closes [#48](https://github.com/cubicecho/agent-mcp-pool/issues/48)
* feat!: leave env and headers out of state() ([5bc6385](https://github.com/cubicecho/agent-mcp-pool/commit/5bc63854db4a95e1e29fab503db726783cf636a9)), closes [#52](https://github.com/cubicecho/agent-mcp-pool/issues/52)


### Bug Fixes

* hold the pool's own copy of every configured row ([435c299](https://github.com/cubicecho/agent-mcp-pool/commit/435c299a66ec339aaa80667ba488373c94f16414)), closes [#51](https://github.com/cubicecho/agent-mcp-pool/issues/51)
* read every page of tools/list ([961d073](https://github.com/cubicecho/agent-mcp-pool/commit/961d073f59fa85d438cc76d21522154566ac4a25)), closes [#47](https://github.com/cubicecho/agent-mcp-pool/issues/47)


### Features

* give every refusal from the pool a code ([5335d51](https://github.com/cubicecho/agent-mcp-pool/commit/5335d5102cc209f4dbf68ccd70ad422f905005b7)), closes [#50](https://github.com/cubicecho/agent-mcp-pool/issues/50)
* report the running child's pid and when it started ([a1c6bd9](https://github.com/cubicecho/agent-mcp-pool/commit/a1c6bd9a3455f08e2a85435082daf002c4bd5b1c)), closes [#49](https://github.com/cubicecho/agent-mcp-pool/issues/49)


### BREAKING CHANGES

* `McpServerState.config` is now `McpServerPublicConfig`, whose
`env` and `headers` are absent unless `state({ secrets: true })` is passed.
* `openai` is no longer a peer dependency, so it is no longer
installed alongside this package. A consumer that relied on that must depend on
it directly. The definitions `tools()` returns are unchanged and still
assignable to `OpenAI.ChatCompletionTool`.

# [0.10.0](https://github.com/cubicecho/agent-mcp-pool/compare/v0.9.0...v0.10.0) (2026-09-07)


### Features

* generate llms.txt from the index ([ee6d322](https://github.com/cubicecho/agent-mcp-pool/commit/ee6d32293aad2adadfd67f738156ef2f5f1fea6a)), closes [#45](https://github.com/cubicecho/agent-mcp-pool/issues/45)

# [0.9.0](https://github.com/cubicecho/agent-mcp-pool/compare/v0.8.0...v0.9.0) (2026-09-07)


### Features

* say when a name nothing offers is skipped ([7dd1421](https://github.com/cubicecho/agent-mcp-pool/commit/7dd14211b548b7ed648c3ecb66bedccac0f23758)), closes [#36](https://github.com/cubicecho/agent-mcp-pool/issues/36)

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
