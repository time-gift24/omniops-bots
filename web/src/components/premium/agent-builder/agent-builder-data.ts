import type { IconSvgElement } from "@hugeicons/react"
import {
  ChromeIcon,
  DatabaseIcon,
  MagicWand01Icon,
  McpServerIcon,
  NoteIcon,
  PackageSearch01Icon,
  Search01Icon,
  Ticket02Icon,
  WorkflowIcon,
} from "@hugeicons-pro/core-stroke-rounded"

export type AgentConfiguration = {
  name: string
  description: string
  instructions: string
  mcpServerIds: string[]
  toolIds: string[]
  skillIds: string[]
  requireApproval: boolean
}

export type AgentResource = {
  id: string
  name: string
  description: string
  icon?: IconSvgElement
}

/** MCP 服务提供的一项能力：工具、资源或提示词。 */
export type McpCapability = {
  name: string
  description: string
  /** 参数摘要，技术下钻信息，等宽展示。 */
  params?: string
}

export type McpCapabilities = {
  tools: readonly McpCapability[]
  resources: readonly McpCapability[]
  prompts: readonly McpCapability[]
}

export type McpServer = AgentResource & { capabilities: McpCapabilities }

export const DEFAULT_AGENT: AgentConfiguration = {
  name: "客户支持",
  description: "回答清楚，跟进得体。",
  instructions:
    "你是客户支持助手。回答时优先使用已连接的工具核实信息，保持清晰简洁。无法确认答案时如实说明，并建议转人工支持。涉及变更客户数据的操作，先征得用户确认。",
  mcpServerIds: ["feishu"],
  toolIds: ["search"],
  skillIds: ["meeting-notes"],
  requireApproval: true,
}

export const MCP_SERVERS: readonly McpServer[] = [
  {
    id: "feishu",
    name: "飞书",
    description: "消息、文档与日程协作",
    icon: McpServerIcon,
    capabilities: {
      tools: [
        {
          name: "发送消息",
          description: "向指定会话发送文本消息",
          params: "chatId: string, text: string",
        },
        {
          name: "搜索文档",
          description: "按关键词检索云文档标题与正文",
          params: "query: string, limit?: number",
        },
        {
          name: "读取日程",
          description: "查询指定时间范围内的日程安排",
          params: "dateRange: [string, string]",
        },
      ],
      resources: [
        {
          name: "云文档索引",
          description: "可访问文档的结构化目录，按空间组织",
        },
      ],
      prompts: [
        {
          name: "会议纪要模板",
          description: "把讨论记录整理为决议与待办的固定格式",
        },
      ],
    },
  },
  {
    id: "browser",
    name: "浏览器",
    description: "在用户的 Chrome 中读取和操作页面",
    icon: ChromeIcon,
    capabilities: {
      tools: [
        {
          name: "打开页面",
          description: "导航到指定 URL 并等待加载完成",
          params: "url: string",
        },
        {
          name: "提取正文",
          description: "读取当前页面的可读文本内容",
        },
        {
          name: "截图",
          description: "截取当前视口或整页图像",
          params: "fullPage?: boolean",
        },
      ],
      resources: [],
      prompts: [],
    },
  },
  {
    id: "database",
    name: "数据查询",
    description: "只读访问业务数据库",
    icon: DatabaseIcon,
    capabilities: {
      tools: [
        {
          name: "执行只读查询",
          description: "运行 SELECT 语句并返回结构化结果",
          params: "sql: string, rowLimit?: number",
        },
      ],
      resources: [
        {
          name: "数据表清单",
          description: "可查询表的名称、字段与行数估计",
        },
        {
          name: "指标字典",
          description: "业务指标的定义与计算口径",
        },
      ],
      prompts: [],
    },
  },
]

export const AGENT_TOOLS: readonly AgentResource[] = [
  {
    id: "search",
    name: "联网搜索",
    description: "检索公开网页并引用来源",
    icon: Search01Icon,
  },
  {
    id: "lookup",
    name: "订单查询",
    description: "从已连接的系统读取订单详情",
    icon: PackageSearch01Icon,
  },
  {
    id: "ticket",
    name: "创建工单",
    description: "把问题升级给人工处理",
    icon: Ticket02Icon,
  },
]

export const AGENT_SKILLS: readonly AgentResource[] = [
  {
    id: "meeting-notes",
    name: "会议纪要",
    description: "把讨论整理成决议、待办和负责人",
    icon: NoteIcon,
  },
  {
    id: "weekly-report",
    name: "周报生成",
    description: "汇总本周进展、风险与下周计划",
    icon: WorkflowIcon,
  },
  {
    id: "release-notes",
    name: "发布说明",
    description: "从变更记录提炼面向用户的更新文案",
    icon: MagicWand01Icon,
  },
]
