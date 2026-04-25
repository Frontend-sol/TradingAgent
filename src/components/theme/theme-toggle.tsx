"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type ThemeMode = "dark" | "light";

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeMode>("dark");

  useEffect(() => {
    const saved = (localStorage.getItem("app-theme") as ThemeMode | null) || "dark";
    document.documentElement.setAttribute("data-theme", saved);
    setTheme(saved);
  }, []);

  const toggleTheme = () => {
    const next: ThemeMode = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("app-theme", next);
    document.documentElement.setAttribute("data-theme", next);
  };

  return (
    <Button variant="outline" onClick={toggleTheme}>
      {theme === "dark" ? "切换明亮主题" : "切换暗色主题"}
    </Button>
  );
}
