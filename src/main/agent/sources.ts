/**
 * Every built-in tool source. Importing this module registers them; order
 * here is the order tools appear in the prompt, which should stay stable (it
 * is part of the cached prefix). Feature modules under `features/` register
 * their own sources when they load.
 */
import './workflowTools'
import '../localTools'
import '../webSearch'
import './pluginTools'
import './swarm'
// Image generation lives with the features but is offered like a built-in tool.
import '../features/images/tool'
