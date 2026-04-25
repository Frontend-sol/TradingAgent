import { redirect } from "next/navigation";

export default function LlmConfigRedirectPage() {
  redirect("/settings");
}