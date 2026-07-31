import Foundation
import XCTest
@testable import Eaon_desktop

final class BackgroundJobsTests: XCTestCase {
    private let jobs = BackgroundJobs.shared

    private func start(
        _ command: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> String {
        switch jobs.start(command: command, workingDirectory: NSTemporaryDirectory()) {
        case .started(let id, _):
            addTeardownBlock { [jobs] in _ = jobs.stop(id: id) }
            return id
        case .failed(let reason):
            XCTFail("Background job failed to start: \(reason)", file: file, line: line)
            return "missing-job"
        }
    }

    private func eventually(
        timeout: TimeInterval = 10,
        _ condition: () -> Bool
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.02)
        } while Date() < deadline
        return condition()
    }

    func testStartReturnsWhileJobIsStillRunningAndOutputAccumulates() {
        let id = start(
            "/bin/echo first; /bin/sleep 0.1; /bin/echo second; /bin/sleep 30"
        )

        XCTAssertTrue(jobs.report(id: id)?.contains("still running") == true)
        XCTAssertTrue(eventually {
            guard let report = self.jobs.report(id: id) else { return false }
            return report.contains("first")
                && report.contains("second")
                && report.contains("still running")
        })
    }

    func testStopReportsStoppedByUser() {
        let id = start("/bin/sleep 30")

        guard case .stopped = jobs.stop(id: id) else {
            return XCTFail("Expected a running job to stop")
        }

        XCTAssertTrue(eventually {
            self.jobs.report(id: id)?.contains("stopped by you") == true
        })
        XCTAssertFalse(jobs.report(id: id)?.contains("exited with code") == true)
    }

    func testNaturalExitSurfacesExitCodeAndCapturesStderr() {
        let id = start(
            "/bin/sleep 0.05; /bin/echo standard-output; "
                + "/bin/echo standard-error >&2; exit 7"
        )

        XCTAssertTrue(eventually {
            self.jobs.report(id: id)?.contains("exited with code 7") == true
        })
        let report = jobs.report(id: id) ?? ""
        XCTAssertTrue(report.contains("standard-output"))
        XCTAssertTrue(report.contains("standard-error"))
    }

    func testUnknownIDsReturnNotFound() {
        let id = "job-does-not-exist-\(UUID().uuidString)"

        XCTAssertNil(jobs.report(id: id))
        guard case .notFound = jobs.stop(id: id) else {
            return XCTFail("Unknown job id should return .notFound")
        }
    }

    func testStoppingFinishedJobReturnsAlreadyFinished() {
        let id = start("/bin/sleep 0.05; exit 3")
        XCTAssertTrue(eventually {
            self.jobs.report(id: id)?.contains("exited with code 3") == true
        })

        guard case .alreadyFinished = jobs.stop(id: id) else {
            return XCTFail("Finished job should return .alreadyFinished")
        }
    }

    func testThousandsOfOutputLinesCompleteWithoutPipeDeadlock() {
        let id = start(
            "i=1; while [ $i -le 10000 ]; do "
                + "echo \"eaon-job-line-$i\"; i=$((i+1)); done"
        )

        XCTAssertTrue(eventually {
            self.jobs.report(id: id)?.contains("exited with code 0") == true
        })
        let report = jobs.report(id: id) ?? ""
        XCTAssertTrue(report.contains("eaon-job-line-10000"))
        XCTAssertTrue(report.contains("earlier output trimmed"))
    }

    func testReportHonorsTailCharacterLimit() {
        let id = start("/bin/sleep 0.05; /bin/echo 1234567890")
        XCTAssertTrue(eventually {
            self.jobs.report(id: id)?.contains("exited with code 0") == true
        })

        let report = jobs.report(id: id, tailCharacters: 5) ?? ""
        XCTAssertTrue(report.contains("earlier output trimmed"))
        XCTAssertTrue(report.hasSuffix("7890\n"))
    }
}
