<!-- BEGIN open-dynamic-workflows -->
## Open Dynamic Workflows

For Zed, route substantial workflow requests through the ODW MCP server when it is available.

Use ODW when the user says `workflow:`, `ultracode`, `/deep-research`, or asks for broad multi-file work that benefits from planning, parallel agents, verification, or crash-resumable execution.

- Call `odw_health` first when uncertain whether the daemon is reachable.
- Use `odw_run` for direct execution. Use `odw_plan` first when the user asks to review the plan, the task is expensive, or mutation risk is high.
- Report the workflow id, topology, agent count, and cost/time estimate instead of redoing the work manually.
- Use `odw_status`, `odw_result`, and `odw_list` to monitor and summarize running work.
- If ODW is unavailable, say exactly what is missing (`odw-daemon start` or `odw-daemon doctor <agent>`) and then fall back to the host agent native planning only if useful.

<!-- END open-dynamic-workflows -->
