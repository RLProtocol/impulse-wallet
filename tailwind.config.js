/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // "Neon Storm" — themed on the Lightning Sprout mascot and matched to
        // the website tokens: a storm-black ground (a hair of green in it, like
        // the mascot's cloud) so the electric lime reads as light off the cloud.
        bg: "#040603",
        surface: "#0A0D07",
        surface2: "#10140B",
        surface3: "#171C0F",
        border: "#20261A",
        hairline: "#141810",
        // Electric lime pulled straight from the sprout (#B6F03C).
        lime: {
          DEFAULT: "#B6F03C",
          bright: "#D2FF4E", // lightning / glow spark
          soft: "#8CD41C",   // pressed / deeper edge
          deep: "#8CD41C",
          dim: "#5D6B33",
          on: "#0A0F06",     // text on lime fills
        },
        fg: "#F3F7EC",
        muted: "#9AA391",
        dim: "#69705F",
        danger: "#FF6B6B",
        up: "#8CE04A",
        down: "#FF6B6B",
        gold: "#FFC542",
      },
      fontFamily: {
        display: ["Orbitron", "system-ui", "sans-serif"],
        sans: ["Sora", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "monospace"],
      },
      // Rounder edges across the board to match the soft, blobby mascot.
      borderRadius: {
        lg: "0.85rem",
        xl: "1.15rem",
        "2xl": "1.4rem",
        "3xl": "1.9rem",
      },
      boxShadow: {
        glow: "0 0 24px -6px rgba(182, 240, 60, 0.55)",
      },
    },
  },
  plugins: [],
};
