# 第三方许可证来源

构建从 Fig 锁文件、Electron 下载目录、预置 DSH 的 npm 锁和安装目录生成清单。配置文件登记改编代码、VI 资产、字体以及随包缺省的上游许可材料。清单保留 npm 安装位置、已解析版本、归档 URL 和完整性，许可文本保留来源和 SHA-256。

- Fig 锁文件中单列了会进入成品的开发依赖。主进程打入 `yaml` 和 electron-vite 的模块兼容代码，构建产物使用 Rolldown 运行辅助代码和 Vite 模块预加载代码。
- `spdx/` 保存 [SPDX License List Data v3.28.0](https://github.com/spdx/license-list-data/tree/v3.28.0/text) 的原文。独立 SPDX 文本保留版权占位符。
- `upstream/` 保存对应发布的许可证和声明。对 DSH 包，补录规则使用包名、版本及 npm 归档的完整性。每个补录文件的原始来源和 SHA-256 见 [配置](../third-party-licenses.config.json)。
- DSH npm 安装的原生或内嵌载荷如自带许可证、版权声明或第三方 NOTICE，会一起收录。LibreOfficeKit 的 macOS Arm64 包要求实际的 LibreOffice LICENSE 和 NOTICE。Koffi 原生包使用同版 `koffi` 发布包的 MIT 原文。sharp-libvips 收录归档内的组件版本表、libvips 8.18.7 的 LGPL 2.1 原文、构建项目的 Apache 2.0 原文及第三方声明。Standard Webhooks 的 JavaScript 库使用同一源码提交内 `libraries/LICENSE` 的 MIT 原文。
- `brotli`、`dfa`、`fontkit` 的上游 README 仅载明 MIT，因此保留该声明与标准 MIT 原文。另保留 Brotli 解码器的 Google Apache 2.0 声明及 Fontkit 引用的 base64-arraybuffer MIT 原文。`data-uri-to-buffer` 在发布 README 内已提供含版权行的完整 MIT 文本。
- `proxy-agent-negotiate 1.1.0` 的 npm 发布和对应源码目录都没有独立许可原文。保存该发布标签指向提交中的上游授权声明及 SPDX MIT 原文。上游没有提供该包独立版权行，材料保留这一限制。
- pnpm 是本机没有兼容 pnpm 时可能另外下载的固定版本。保存该 npm 归档的原始 MIT 许可证和包内附带的其他许可文件。外部已安装的工具、用户自装的插件由其各自来源提供。

新增证据时先核对上游版本、提交或实际 npm 归档，再补原文和来源。保留现有许可证及版权行。构建不会联网回填缺项。
