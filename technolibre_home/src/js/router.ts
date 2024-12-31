import { Component } from "@odoo/owl";
import { routes } from "./routes";

export interface GetComponentResult {
	component: Component | undefined;
}

export class SimpleRouter {
	public getComponent(route: string): GetComponentResult {
		const nonWildcardRoutes = routes.filter(route => route.pathname !== "*");

		for (let savedRoute of nonWildcardRoutes) {
			const routeMatchResult = this.doRoutesMatch(route, savedRoute.pathname);

			if (routeMatchResult) {
				return { component: savedRoute.component };
			}
		}

		const wildcard = routes.filter(route => route.pathname === "*")?.[0];
		return { component: wildcard?.component };
	}

	public splitRoute(route: string): string[] {
		return route.split("/").filter(routeSegment => routeSegment !== "");
	}

	public doRoutesMatch(incomingRoute: string, routeToMatch: string): boolean {
		const splitIncomingRoute = this.splitRoute(incomingRoute);
		const splitRouteToMatch = this.splitRoute(routeToMatch);

		if (splitIncomingRoute.length != splitRouteToMatch.length && !this.hasWildcardSegment(splitRouteToMatch)) {
			return false;
		}

		for (let i = 0; i < splitIncomingRoute.length; i++) {
			if (this.isParamSegment(splitRouteToMatch[i])) {
				continue;
			}
			if (this.isWildcardSegment(splitRouteToMatch[i])) {
				return true;
			}
			if (splitIncomingRoute[i] !== splitRouteToMatch[i]) {
				return false;
			}
		}

		return true;
	}

	public getRouteParams(incomingRoute: string, routeWithParams?: string): Map<string, string> {
		const paramRoute = routeWithParams || this.getMatchingRoute(incomingRoute);

		const routeParams: Map<string, string> = new Map();

		if (!paramRoute) {
			return routeParams;
		}

		const splitIncomingRoute = this.splitRoute(incomingRoute);
		const splitParamRoute = this.splitRoute(paramRoute);

		const numIterations = Math.min(splitIncomingRoute.length, splitParamRoute.length);

		for (let i = 0; i < numIterations; i++) {
			if (this.isParamSegment(splitParamRoute[i])) {
				routeParams[splitParamRoute[i].slice(1)] = splitIncomingRoute[i];
			}
		}

		return routeParams;
	}

	getMatchingRoute(route: string): string | undefined {
		const nonWildcardRoutes = routes.filter(route => route.pathname !== "*");

		for (let savedRoute of nonWildcardRoutes) {
			if (this.doRoutesMatch(route, savedRoute.pathname)) {
				return savedRoute.pathname;
			}
		}

		const wildcard = routes.filter(route => route.pathname === "*")?.[0];
		return wildcard.pathname;
	}

	private isParamSegment(segment: string): boolean {
		return segment?.[0] === ":";
	}

	private isWildcardSegment(segment: string): boolean {
		return segment === "*";
	}

	private hasWildcardSegment(splitRoute: string[]): boolean {
		return splitRoute.filter(segment => segment === "*").length > 0;
	}
}
