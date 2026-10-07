"use client";

import { LucideIcon } from "lucide-react";
import { ComponentType, SVGProps } from "react";

// custom icons
export * from "@inflect/ui/components/ui/icons/arrow-up-right-2";
export * from "@inflect/ui/components/ui/icons/copy";
export * from "@inflect/ui/components/ui/icons/crown-small";
export * from "./dub-analytics";
export * from "./dub-api";
export * from "./dub-crafted-shield";
export * from "./dub-links";
export * from "./dub-partners";
export * from "./dub-product-icon";
export * from "@inflect/ui/components/ui/icons/expanding-arrow";
export * from "@inflect/ui/components/ui/icons/file-pen";
export * from "@inflect/ui/components/ui/icons/file-send";
export * from "@inflect/ui/components/ui/icons/ios-app-store";
export * from "@inflect/ui/components/ui/icons/lock-small";
export * from "@inflect/ui/components/ui/icons/magic";
export * from "@inflect/ui/components/ui/icons/markdown-icon";
export * from "@inflect/ui/components/ui/icons/matrix-lines";
export * from "@inflect/ui/components/ui/icons/photo";
export * from "@inflect/ui/components/ui/icons/sort-order";
export * from "@inflect/ui/components/ui/icons/success";
export * from "@inflect/ui/components/ui/icons/tick";
export * from "@inflect/ui/components/ui/icons/user-clock";
export * from "@inflect/ui/components/ui/icons/verified-badge";

// loaders
export * from "@inflect/ui/components/ui/icons/loading-circle";
export * from "@inflect/ui/components/ui/icons/loading-dots";
export * from "@inflect/ui/components/ui/icons/loading-spinner";

// brand logos
export * from "@inflect/ui/components/ui/icons/anthropic";
export * from "@inflect/ui/components/ui/icons/bing";
export * from "@inflect/ui/components/ui/icons/facebook";
export * from "@inflect/ui/components/ui/icons/github";
export * from "@inflect/ui/components/ui/icons/google";
export * from "@inflect/ui/components/ui/icons/instagram";
export * from "@inflect/ui/components/ui/icons/linkedin";
export * from "@inflect/ui/components/ui/icons/openai";
export * from "@inflect/ui/components/ui/icons/product-hunt";
export * from "@inflect/ui/components/ui/icons/reddit";
export * from "@inflect/ui/components/ui/icons/slack";
export * from "@inflect/ui/components/ui/icons/tiktok";
export * from "@inflect/ui/components/ui/icons/twitter";
export * from "@inflect/ui/components/ui/icons/unsplash";
export * from "@inflect/ui/components/ui/icons/veriff";
export * from "@inflect/ui/components/ui/icons/youtube";

// Payment platforms
export * from "@inflect/ui/components/ui/icons/payment-platforms/card-amex";
export * from "@inflect/ui/components/ui/icons/payment-platforms/card-discover";
export * from "@inflect/ui/components/ui/icons/payment-platforms/card-mastercard";
export * from "@inflect/ui/components/ui/icons/payment-platforms/card-visa";
export * from "@inflect/ui/components/ui/icons/payment-platforms/paypal";
export * from "@inflect/ui/components/ui/icons/payment-platforms/stablecoin";
export * from "@inflect/ui/components/ui/icons/payment-platforms/stripe-icon";
export * from "@inflect/ui/components/ui/icons/payment-platforms/stripe-link";

// SDKs
export * from "@inflect/ui/components/ui/icons/go";
export * from "@inflect/ui/components/ui/icons/php";
export * from "@inflect/ui/components/ui/icons/python";
export * from "@inflect/ui/components/ui/icons/ruby";
export * from "@inflect/ui/components/ui/icons/typescript";

// continent icons
export * from "@inflect/ui/components/ui/icons/continents";

// default-domain logos
export * from "@inflect/ui/components/ui/icons/default-domains/amazon";
export * from "@inflect/ui/components/ui/icons/default-domains/chatgpt";
export * from "@inflect/ui/components/ui/icons/default-domains/figma";
export * from "@inflect/ui/components/ui/icons/default-domains/github-enhanced";
export * from "@inflect/ui/components/ui/icons/default-domains/google-enhanced";
export * from "@inflect/ui/components/ui/icons/default-domains/spotify";

// Nucleo icons
export * from "@inflect/ui/components/ui/icons/nucleo";

// Feature icons for pricing table
export * from "./plan-feature-icons";

export type Icon = LucideIcon | ComponentType<SVGProps<SVGSVGElement>>;
