import { lazy, Suspense, useEffect, useState } from "react";
import logo from "./logo.svg";

// A chunk of its own, loaded later by a relative dynamic import.
const Details = lazy(() => import("./Details.jsx"));

export default function App() {
  const [data, setData] = useState(null);
  const [count, setCount] = useState(0);
  useEffect(() => {
    // A file published beside the page, by relative URL.
    fetch("./data.json")
      .then((response) => response.json())
      .then(setData, (error) => setData({ error: String(error) }));
  }, []);
  return (
    <main id="app" data-ready={data === null ? "no" : "yes"}>
      <img id="logo" src={logo} alt="logo" width="48" height="48" />
      <h1>Vite fixture</h1>
      <p id="data">{data === null ? "loading" : (data.message ?? data.error)}</p>
      <button id="count" type="button" onClick={() => setCount(count + 1)}>
        count {count}
      </button>
      <Suspense fallback={<p id="details">loading details</p>}>
        <Details />
      </Suspense>
    </main>
  );
}
