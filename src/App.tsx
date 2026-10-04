import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { CreateTask } from "./pages/CreateTask";
import { Decision } from "./pages/Decision";
import { LiveCreateTask } from "./pages/LiveCreateTask";
import { LiveErrorBoundary } from "./live/LiveErrorBoundary";
import { LiveProductErrorBoundary } from "./live/product/ErrorBoundary";
import { LiveProductB1ErrorBoundary } from "./live/productB1/ErrorBoundary";
import { LiveProductB2ErrorBoundary } from "./live/productB2/ErrorBoundary";
import { LiveProductTimeoutErrorBoundary } from "./live/productTimeout/ErrorBoundary";
import { LiveProductV2ErrorBoundary } from "./live/productV2/ErrorBoundary";
import { LiveProductB1Test } from "./pages/LiveProductB1Test";
import { LiveProductB2Test } from "./pages/LiveProductB2Test";
import { LiveProductTimeoutTest } from "./pages/LiveProductTimeoutTest";
import { LiveProductV2Test } from "./pages/LiveProductV2Test";
import { LiveProductTest } from "./pages/LiveProductTest";
import { LiveSettlementTest } from "./pages/LiveSettlementTest";
import { LiveDecision } from "./pages/LiveDecision";
import { LiveStringLibrary } from "./pages/LiveStringLibrary";
import { LiveSubmitTranslation } from "./pages/LiveSubmitTranslation";
import { LiveTaskBoard } from "./pages/LiveTaskBoard";
import { LiveTaskDetail } from "./pages/LiveTaskDetail";
import { StringLibrary } from "./pages/StringLibrary";
import { SubmitTranslation } from "./pages/SubmitTranslation";
import { TaskBoard } from "./pages/TaskBoard";
import { TaskDetail } from "./pages/TaskDetail";
import { LiveProductUiV2ErrorBoundary } from "./live/productUiV2/ErrorBoundary";
import { V2CreateTask } from "./pages/V2CreateTask";
import { V2Decision } from "./pages/V2Decision";
import { V2StringLibrary } from "./pages/V2StringLibrary";
import { V2SubmitTranslation } from "./pages/V2SubmitTranslation";
import { V2TaskBoard } from "./pages/V2TaskBoard";
import { V2TaskDetail } from "./pages/V2TaskDetail";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/v2" replace />} />
        <Route path="/v1" element={<LiveTaskBoard />} />
        <Route path="/tasks/new" element={<LiveCreateTask />} />
        <Route path="/tasks/:id/submit" element={<LiveSubmitTranslation />} />
        <Route path="/tasks/:id/decision" element={<LiveDecision />} />
        <Route path="/tasks/:id" element={<LiveTaskDetail />} />
        <Route path="/library" element={<LiveStringLibrary />} />
        <Route path="/demo" element={<TaskBoard />} />
        <Route path="/demo/tasks/new" element={<CreateTask />} />
        <Route path="/demo/tasks/:id" element={<TaskDetail />} />
        <Route path="/demo/tasks/:id/submit" element={<SubmitTranslation />} />
        <Route path="/demo/tasks/:id/decision" element={<Decision />} />
        <Route path="/demo/library" element={<StringLibrary />} />
        <Route
          path="/live-settlement"
          element={
            <LiveErrorBoundary>
              <LiveSettlementTest />
            </LiveErrorBoundary>
          }
        />
        <Route
          path="/live-product"
          element={
            <LiveProductErrorBoundary>
              <LiveProductTest />
            </LiveProductErrorBoundary>
          }
        />
        <Route
          path="/live-product-b1"
          element={
            <LiveProductB1ErrorBoundary>
              <LiveProductB1Test />
            </LiveProductB1ErrorBoundary>
          }
        />
        <Route
          path="/live-product-b2"
          element={
            <LiveProductB2ErrorBoundary>
              <LiveProductB2Test />
            </LiveProductB2ErrorBoundary>
          }
        />
        <Route
          path="/live-product-timeout"
          element={
            <LiveProductTimeoutErrorBoundary>
              <LiveProductTimeoutTest />
            </LiveProductTimeoutErrorBoundary>
          }
        />
        <Route
          path="/live-product-v2"
          element={
            <LiveProductV2ErrorBoundary>
              <LiveProductV2Test />
            </LiveProductV2ErrorBoundary>
          }
        />
        <Route
          path="/v2"
          element={
            <LiveProductUiV2ErrorBoundary>
              <V2TaskBoard />
            </LiveProductUiV2ErrorBoundary>
          }
        />
        <Route
          path="/v2/tasks/new"
          element={
            <LiveProductUiV2ErrorBoundary>
              <V2CreateTask />
            </LiveProductUiV2ErrorBoundary>
          }
        />
        <Route
          path="/v2/tasks/:id/submit"
          element={
            <LiveProductUiV2ErrorBoundary>
              <V2SubmitTranslation />
            </LiveProductUiV2ErrorBoundary>
          }
        />
        <Route
          path="/v2/tasks/:id/decision"
          element={
            <LiveProductUiV2ErrorBoundary>
              <V2Decision />
            </LiveProductUiV2ErrorBoundary>
          }
        />
        <Route
          path="/v2/tasks/:id"
          element={
            <LiveProductUiV2ErrorBoundary>
              <V2TaskDetail />
            </LiveProductUiV2ErrorBoundary>
          }
        />
        <Route
          path="/v2/library"
          element={
            <LiveProductUiV2ErrorBoundary>
              <V2StringLibrary />
            </LiveProductUiV2ErrorBoundary>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
