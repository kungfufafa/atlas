export const BUILTIN_TOOL_IDS = {
  browser: "tool_browser",
  calculator: "tool_calculator",
  channel_action: "tool_channel_action",
  copy_file: "tool_copy_file",
  create_directory: "tool_create_directory",
  deep_research: "tool_deep_research",
  delete_file: "tool_delete_file",
  edit_file: "tool_edit_file",
  email: "tool_email",
  extract_document_text: "tool_extract_document_text",
  file_asset: "tool_file_asset",
  file_stat: "tool_file_stat",
  get_conversation: "tool_get_conversation",
  knowledge_base_search: "tool_knowledge_base_search",
  list_directory: "tool_list_directory",
  memory_delete: "tool_memory_delete",
  memory_list: "tool_memory_list",
  memory_search: "tool_memory_search",
  memory_update: "tool_memory_update",
  memory_write: "tool_memory_write",
  move_file: "tool_move_file",
  office_document: "tool_office_document",
  pdf_document: "tool_pdf_document",
  read_file: "tool_read_file",
  search_chats: "tool_search_chats",
  search_files: "tool_search_files",
  send_whatsapp: "tool_send_whatsapp",
  spreadsheet: "tool_spreadsheet",
  web_fetch: "tool_web_fetch",
  web_search: "tool_web_search",
  write_docx: "tool_write_docx",
  write_file: "tool_write_file",
  write_pptx: "tool_write_pptx",
} as const;

export const BASH_TOOL_ID = "tool_bash";
export const SUB_AGENT_TOOL_ID = "tool_sub_agent";
export const GENERATE_IMAGE_TOOL_ID = "tool_generate_image";
export const PYTHON_EXECUTE_TOOL_ID = "tool_python_execute";
export const TOOL_SEARCH_TOOL_ID = "tool_tool_search";

export const PROTECTED_TOOL_IDS = new Set<string>([
  ...Object.values(BUILTIN_TOOL_IDS),
  BASH_TOOL_ID,
  SUB_AGENT_TOOL_ID,
  GENERATE_IMAGE_TOOL_ID,
  PYTHON_EXECUTE_TOOL_ID,
  TOOL_SEARCH_TOOL_ID,
]);

export function isProtectedToolId(toolId: string): boolean {
  return PROTECTED_TOOL_IDS.has(toolId);
}

export const MEMORY_TOOL_NAMES = [
  "memory_delete",
  "memory_list",
  "memory_search",
  "memory_update",
  "memory_write",
] as const;

export const CONVERSATION_TOOL_NAMES = [
  "get_conversation",
  "search_chats",
] as const;

export type ServerToolHandlerType =
  | "memory"
  | "conversation"
  | "bash"
  | "sub_agent"
  | "generate_image"
  | "python_execute"
  | "tool_search";

const MEMORY_TOOL_NAME_SET = new Set<string>(MEMORY_TOOL_NAMES);
const CONVERSATION_TOOL_NAME_SET = new Set<string>(CONVERSATION_TOOL_NAMES);

export function serverHandlerTypeForToolName(
  name: string
): ServerToolHandlerType | null {
  if (MEMORY_TOOL_NAME_SET.has(name) || name.startsWith("memory_")) {
    return "memory";
  }
  if (CONVERSATION_TOOL_NAME_SET.has(name)) {
    return "conversation";
  }
  if (name === "bash") {
    return "bash";
  }
  if (name === "sub_agent") {
    return "sub_agent";
  }
  if (name === "generate_image") {
    return "generate_image";
  }
  if (name === "python_execute") {
    return "python_execute";
  }
  if (name === "tool_search") {
    return "tool_search";
  }
  return null;
}
