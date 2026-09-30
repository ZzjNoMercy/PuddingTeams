/** A permission error still proves the PID exists; only ESRCH proves it is gone. */
export function pidAlive(pid, signal = process.kill) {
	try {
		signal(pid, 0);
		return true;
	} catch (error) {
		if (error?.code === "EPERM") return true;
		if (error?.code === "ESRCH") return false;
		throw error;
	}
}

/** Never signal a PID unless the listener proves it is this CLI's server instance. */
export function matchesManagedHealth(runState, health, dataHomeId) {
	return Boolean(
		runState?.runId &&
		health?.ok === true &&
		health?.service === "puddingteams-server" &&
		health?.runId === runState.runId &&
		health?.dataHomeId === dataHomeId,
	);
}
