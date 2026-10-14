import assert from 'node:assert/strict';

// Fixtures own their Agent registration; fresh installations need no external service.
export async function registerPuddingClawFixture(base, command = 'puddingclaw') {
	const response = await fetch(`${base}/api/agents`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name: 'puddingclaw', description: 'Installed protocol fixture', enabled: true,
			connector: { extensionId: 'puddingclaw', connectorId: 'puddingclaw', transport: 'spawn', config: { command } } }),
	});
	const result = await response.json();
	assert.equal(response.status, 200, JSON.stringify(result));
}
