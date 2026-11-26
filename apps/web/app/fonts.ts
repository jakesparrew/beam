import { Inter, Lora, Poppins, Rufina } from "next/font/google";

// BEAM brand fonts, self-hosted by next/font (no request to Google from the visitor's browser).
export const poppins = Poppins({ subsets: ["latin"], weight: ["400", "500", "600", "700", "900"], variable: "--font-poppins", display: "swap" });
export const lora = Lora({ subsets: ["latin"], weight: ["600"], variable: "--font-lora", display: "swap" });
export const rufina = Rufina({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-rufina", display: "swap" });
// The back-office interface face: Inter (tabular figures for data), Cal.com / Linear style.
export const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
