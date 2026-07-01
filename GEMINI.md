<!-- BEGIN open-dynamic-workflows -->
## Open Dynamic Workflows

For Gemini CLI, route substantial workflow requests through the ODW MCP server when it is available.

Use ODW when the user says `workflow:`, `ultracode`, `/deep-research`, or asks for broad multi-file work that benefits from planning, parallel agents, verification, or crash-resumable execution.

- Gemini CLI exposes ODW tools with the MCP prefix: `mcp_odw_odw_health`, `mcp_odw_odw_plan`, `mcp_odw_odw_run`, `mcp_odw_odw_status`, `mcp_odw_odw_result`, `mcp_odw_odw_list`, and `mcp_odw_odw_control`.
- Call `mcp_odw_odw_health` first when uncertain whether the daemon is reachable.
- Use `mcp_odw_odw_run` (`odw_run`) for direct execution. Use `mcp_odw_odw_plan` (`odw_plan`) first when the user asks to review the plan, the task is expensive, or mutation risk is high.
- Report the workflow id, topology, agent count, and cost/time estimate instead of redoing the work manually.
- Use `mcp_odw_odw_status`, `mcp_odw_odw_result`, and `mcp_odw_odw_list` to monitor and summarize running work.
- If ODW is unavailable, say exactly what is missing (`odw-daemon start` or `odw-daemon doctor gemini`) and then fall back to Gemini-native planning only if useful.

<!-- END open-dynamic-workflows -->
