/**
 * A route: which model a task runs on, and at what effort. `model` is an
 * alias (`haiku`, `sonnet`, `opus`, `fable`), a full model id, or `inherit`
 * (leave the engine's choice alone). `level` is an effort level, or absent
 * for the model's default.
 */
export type LobotomyRoute = { model?: string; level?: string }

/**
 * The whole configuration: one route per task id or override key
 * (`main`, `plan`, `agent:Explore`, `skill:code-review`, ...).
 */
export type LobotomyConfig = { tasks: Record<string, LobotomyRoute> }

declare module 'claude-code' {
  interface PluginState {
    lobotomy: {
      /** The routes, mirrored from `$.store` for drawing. */
      config: LobotomyConfig
      /** The task the running main turn was assigned (`quick`, `review`, ...). */
      turnTask: string | null
      /** The session's permission mode as the classic hooks last reported it. */
      mode: string
      /** Agent types the engine has offered the model, for the override rows. */
      agentTypes: string[]
      /** The task whose custom model id is being typed in the pane. */
      customFor: string | null
      /** What the last routed request ran on, for the pane's status line. */
      lastRoute: string
    }
  }
}
