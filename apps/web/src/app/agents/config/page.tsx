import { AgentConfigPage } from "@/components/agent-config/agent-config-page";

export default async function Page({ params }: { params: Promise<{ name: string }> }) {
	const { name } = await params;
	return <AgentConfigPage name={name} />;
}
