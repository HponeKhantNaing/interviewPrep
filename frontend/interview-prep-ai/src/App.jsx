import React from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import { Toaster } from "react-hot-toast";

import LandingPage from "./pages/LandingPage";
import Dashboard from "./pages/Home/Dashboard";
import InterviewPrep from "./pages/InterviewPrep/InterviewPrep";
import Feedback from "./pages/InterviewPrep/Feedback";
import InterviewTest from "./pages/Home/InterviewTest";
import InterviewTestSession from "./pages/Home/InterviewTestSession";
import InterviewTestFeedback from "./pages/Home/InterviewTestFeedback";
import UserProvider from "./context/userContext";

const App = () => {
  return (
    <UserProvider>
      <div>
        <Router>
          <Routes>
            {/* Default Route */}
            <Route path="/" element={<LandingPage />} />

            <Route path="/dashboard" element={<Dashboard />} />
            <Route
              path="/interview-prep/:sessionId"
              element={<InterviewPrep />}
            />
            <Route
              path="/interview-prep/:sessionId/feedback"
              element={<Feedback />}
            />
            <Route
              path="/interview-test"
              element={<InterviewTest />}
            />
            <Route
              path="/interview-test/:sessionId"
              element={<InterviewTestSession />}
            />
            <Route
              path="/interview-test/:sessionId/feedback"
              element={<InterviewTestFeedback />}
            />
          </Routes>
        </Router>

        <Toaster
          toastOptions={{
            className: "",
            style: {
              fontSize: "13px",
            },
          }}
        />
      </div>
    </UserProvider>
  );
};

export default App;
