Put `screenshot.png` here.

Grok Bot 公用编制（项目经理 / 开发 / 测试 / 评审，可复制到任意产品）：[grok-bot-kit/](grok-bot-kit/README.md)。

It is what the plugin's store card shows, and the registry REJECTS a plugin whose README has no
screenshot that resolves to a real image — so this is not optional.

  - 16:9, 1600×900 is ideal. The card crops the edges, so leave some margin.
  - Show the plugin doing its job, in context, inside TREK.

The quickest way: run `trek-plugin dev`, then `trek-plugin shot` in another terminal — it
renders your plugin in a themed TREK frame and writes docs/screenshot.png for you.

This directory is NOT shipped in plugin.zip; it lives in your repo, and the README links it at the
commit the registry pins.
