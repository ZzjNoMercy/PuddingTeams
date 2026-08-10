# Minimal Tool Capability

真实、无副作用的 Capability Extension 样例。安装后绑定到 Agent，manager 可按需激活命名空间工具 `agent_<agentId>__minimal-tool__build_checklist`。

它刻意不访问宿主、网络、workspace 或密钥，用来验证 manifest → catalog → Agent binding → 工具装配的最小闭环。
