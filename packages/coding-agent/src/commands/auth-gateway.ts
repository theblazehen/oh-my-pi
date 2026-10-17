/**
 * `omp auth-gateway` — run a forward proxy that injects auth from the broker.
 */

import type { AuthGatewayApiKeyScope } from "@oh-my-pi/pi-ai/auth-gateway";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import {
	AUTH_GATEWAY_ACTIONS,
	type AuthGatewayAction,
	type AuthGatewayCommandArgs,
	runAuthGatewayCommand,
} from "../cli/auth-gateway-cli";
import { GATEWAY_API_KEY_SCOPES } from "../cli/auth-gateway-keys";
import { authGatewayHelp as commandHelp } from "../cli/command-help";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

export default class AuthGateway extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Sub-command",
			required: false,
			options: [...AUTH_GATEWAY_ACTIONS],
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON (token/status/check)" }),
		bind: Flags.string({ description: "Bind address for `serve` (host:port)", char: "b" }),
		regenerate: Flags.boolean({ description: "Regenerate the gateway bearer token, or the --name key (token)" }),
		name: Flags.string({
			description:
				"Named API key to print (created on first use), rotate with --regenerate, or remove with --revoke (token); usage is attributed to the name",
		}),
		revoke: Flags.boolean({ description: "Remove the --name API key (token)" }),
		scope: Flags.string({
			description:
				"Scope for the --name key (token): `inference` (default for new keys) reaches only inference routes and /v1/models; `full` also reaches /v1/usage and /v1/credentials/check",
			options: [...GATEWAY_API_KEY_SCOPES],
		}),
		"no-auth": Flags.boolean({
			description:
				"Disable inbound bearer-token auth (serve). Useful when bound to loopback — any caller is allowed.",
		}),
		"trust-proxy-headers": Flags.boolean({
			description: "Trust forwarded peer IP headers from a reverse proxy (serve); off by default.",
		}),
		strict: Flags.boolean({
			description:
				"For `check`: additionally probe each credential against its provider's chat-completion endpoint. Slower; consumes a tiny amount of quota per credential.",
		}),
	};

	static examples = [
		"# Boot the gateway against the configured broker\n  omp auth-gateway serve",
		'# Serve the same routes as JSON lines on stdin/stdout with your own credentials\n  echo \'{"id":1,"path":"/v1/chat/completions","body":{"model":"@smol","messages":[{"role":"user","content":"hi"}]}}\' | omp auth-gateway stdio',
		"# Boot on a non-default port\n  omp auth-gateway serve --bind=127.0.0.1:4000",
		"# Trust client IP headers from a trusted reverse proxy\n  omp auth-gateway serve --trust-proxy-headers",
		"# Print the gateway bearer token (creates one on first run)\n  omp auth-gateway token",
		"# Rotate the gateway bearer token\n  omp auth-gateway token --regenerate",
		"# Print the inference-only API key for a client (created on first use); its usage is attributed to `laptop`\n  omp auth-gateway token --name laptop",
		"# A key that may also read account usage and credential health (e.g. a usage widget)\n  omp auth-gateway token --name widget --scope full",
		"# Rotate or remove a named API key (a running gateway applies it within 10s)\n  omp auth-gateway token --name laptop --regenerate\n  omp auth-gateway token --name laptop --revoke",
		"# List named API keys and their scopes\n  omp auth-gateway keys",
		"# Run on loopback without any bearer (anyone on this host can call)\n  omp auth-gateway serve --no-auth",
		"# Show local gateway + broker config status\n  omp auth-gateway status",
		"# Probe each broker credential to see which one is producing 401s\n  omp auth-gateway check",
		"# Same, machine-readable for scripts\n  omp auth-gateway check --json",
		"# Strict check — also exercises each credential with a real chat-completion ping\n  omp auth-gateway check --strict",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(AuthGateway);
		if (!args.action) {
			renderCommandHelp("omp", "auth-gateway", AuthGateway);
			return;
		}
		const cmd: AuthGatewayCommandArgs = {
			action: args.action as AuthGatewayAction,
			flags: {
				json: flags.json,
				bind: flags.bind,
				regenerate: flags.regenerate,
				name: flags.name,
				revoke: flags.revoke,
				scope: flags.scope as AuthGatewayApiKeyScope | undefined,
				noAuth: flags["no-auth"],
				trustProxyHeaders: flags["trust-proxy-headers"],
				strict: flags.strict,
			},
		};
		await initTheme();
		await runAuthGatewayCommand(cmd);
	}
}
