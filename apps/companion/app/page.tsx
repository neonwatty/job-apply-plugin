import { connection } from "next/server";
import Companion from "../components/Companion";
export default async function Page() {
  await connection();
  return <Companion />;
}
