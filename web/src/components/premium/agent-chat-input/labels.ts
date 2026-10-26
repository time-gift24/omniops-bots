const labels: Record<string, string> = {
  placeholder: "问点什么，或者直接开始构建…",
  credits: "剩余 {count} 额度",
  attachFiles: "添加附件",
  addContext: "添加上下文",
  voiceInput: "语音输入",
  sendMessage: "发送",
  stopResponse: "停止响应",
  enableSearch: "开启联网搜索",
  disableSearch: "关闭联网搜索",
  searchLabel: "联网",
  selectModel: "选择模型: {model}",
  models: "模型",
  skills: "技能",
  noSkills: "没有匹配的技能",
  personal: "个人",
  dismissCredits: "关闭额度提示",
  upgrade: "升级",
  reviewContext: "请查看附带的上下文。",
  previewFile: "预览 {name}",
  removeFile: "移除附件 {name}",
  closePreview: "关闭图片预览",
  fileOnly: "仅保留文件名",
  agentPrompt: "消息输入",
  skillLabel: "技能：{name}",
  addFirstSource: "添加第一个来源",
  knowledgeBase: "知识库",
}
export function composerText(
  key: string,
  values: Record<string, string | number> = {}
) {
  return (labels[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) =>
    String(values[name] ?? "")
  )
}
