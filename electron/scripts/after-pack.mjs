#!/usr/bin/env node
/**
 * electron-builder 的 Electron macOS 模板会默认加入宽泛 ATS 与多项媒体权限
 * 说明。PuddingTeams 只加载自身 loopback server，BrowserWindow 也拒绝所有
 * permission request，因此在签名前把 Info.plist 收口到真实能力。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const UNUSED_PRIVACY_KEYS = [
	"NSAudioCaptureUsageDescription",
	"NSBluetoothAlwaysUsageDescription",
	"NSBluetoothPeripheralUsageDescription",
	"NSCameraUsageDescription",
	"NSMicrophoneUsageDescription",
];

function plistBuddy(command, plist) {
	return execFileSync("/usr/libexec/PlistBuddy", ["-c", command, plist], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

export default async function afterPack(context) {
	if (context.electronPlatformName !== "darwin") return;
	const productName = context.packager.appInfo.productFilename;
	const plist = path.join(context.appOutDir, `${productName}.app`, "Contents", "Info.plist");

	plistBuddy("Set :NSAppTransportSecurity:NSAllowsArbitraryLoads false", plist);
	for (const key of UNUSED_PRIVACY_KEYS) {
		try {
			plistBuddy(`Delete :${key}`, plist);
		} catch {
			// Electron 模板版本未包含该 key 时无需处理。
		}
	}
}
