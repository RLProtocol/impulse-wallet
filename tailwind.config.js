/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "hsl(156 24% 6%)",
        surface: "hsl(156 20% 10%)",
        surface2: "hsl(156 16% 14%)",
        border: "hsl(150 14% 19%)",
        lime: {
          DEFAULT: "hsl(82 92% 55%)",
          soft: "hsl(90 60% 45%)",
          dim: "hsl(100 30% 30%)",
        },
        muted: "hsl(100 18% 81%)",
        danger: "hsl(0 84% 62%)",
        up: "hsl(142 70% 50%)",
        down: "hsl(0 84% 62%)",
      },
      fontFamily: {
        display: ["Orbitron", "system-ui", "sans-serif"],
        sans: ["Sora", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        glow: "0 0 24px -6px hsl(82 92% 55% / 0.5)",
      },
    },
  },
  plugins: [],
};
