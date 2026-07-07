import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { decideToolCallFromContext } from "./policy.ts";

type ToolCallRegistration = {
	on(
		event: "tool_call",
		handler: (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallEventResult | undefined,
	): void;
};

export default function guardrailExtension(pi: ExtensionAPI) {
	const toolCallApi = pi as ExtensionAPI & ToolCallRegistration;
	toolCallApi.on("tool_call", (event, ctx) => {
		const decision = decideToolCallFromContext(event, ctx);
		if (decision.block) {
			return { block: true, reason: decision.reason };
		}
		return undefined;
	});
}
