#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <cwchar>
#include <string>
#include <vector>

namespace {

constexpr SIZE_T kProcessMemoryLimitBytes = 256ULL * 1024ULL * 1024ULL;
constexpr SIZE_T kJobMemoryLimitBytes = 192ULL * 1024ULL * 1024ULL;
constexpr DWORD kActiveProcessLimit = 1;
constexpr DWORD kCpuRate = 2000;  // 20.00%, in 1/100ths of a percent.
constexpr DWORD kParentExitWaitMs = 2000;
constexpr DWORD kParentLivenessPollMs = 25;
constexpr DWORD kInputCloseWorkerExitGraceMs = 100;

constexpr int kExitInvalidLaunch = 40;
constexpr int kExitHostPolicy = 41;
constexpr int kExitJob = 42;
constexpr int kExitToken = 43;
constexpr int kExitCreate = 44;
constexpr int kExitAssign = 45;
constexpr int kExitAttestation = 46;
constexpr int kExitResume = 47;
constexpr int kExitWorker = 48;

class UniqueHandle {
 public:
  UniqueHandle() = default;
  explicit UniqueHandle(HANDLE value) : value_(value) {}
  ~UniqueHandle() { reset(); }
  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;
  UniqueHandle(UniqueHandle&& other) noexcept : value_(other.release()) {}
  UniqueHandle& operator=(UniqueHandle&& other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }
  HANDLE get() const { return value_; }
  explicit operator bool() const { return value_ != nullptr && value_ != INVALID_HANDLE_VALUE; }
  HANDLE release() {
    HANDLE value = value_;
    value_ = nullptr;
    return value;
  }
  void reset(HANDLE value = nullptr) {
    if (value_ != nullptr && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
    value_ = value;
  }

 private:
  HANDLE value_ = nullptr;
};

struct AttributeList {
  LPPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
  ~AttributeList() {
    if (value != nullptr) {
      DeleteProcThreadAttributeList(value);
      HeapFree(GetProcessHeap(), 0, value);
    }
  }
};

enum class FaultStage {
  kNone,
  kJob,
  kToken,
  kCreate,
  kAssign,
  kAttestation,
  kResume,
};

#ifdef XIAOQIE_CONTAINMENT_TEST_BUILD
bool EqualsIgnoreCase(const std::wstring& left, const std::wstring& right) {
  return _wcsicmp(left.c_str(), right.c_str()) == 0;
}
#endif

bool EndsWithIgnoreCase(const std::wstring& value, const wchar_t* suffix) {
  const size_t suffix_length = std::wcslen(suffix);
  return value.size() >= suffix_length &&
         _wcsicmp(value.c_str() + value.size() - suffix_length, suffix) == 0;
}

bool ContainsForbiddenCommandCharacter(const std::wstring& value) {
  return value.empty() || value.find(L'"') != std::wstring::npos ||
         value.find(L'\r') != std::wstring::npos || value.find(L'\n') != std::wstring::npos;
}

bool CanonicalExistingFile(const wchar_t* input, std::wstring* output) {
  if (input == nullptr || output == nullptr) return false;
  const DWORD required = GetFullPathNameW(input, 0, nullptr, nullptr);
  if (required == 0 || required > 32768) return false;
  std::vector<wchar_t> buffer(required + 1, L'\0');
  const DWORD written = GetFullPathNameW(input, static_cast<DWORD>(buffer.size()), buffer.data(), nullptr);
  if (written == 0 || written >= static_cast<DWORD>(buffer.size())) return false;
  std::wstring path(buffer.data(), written);
  if (ContainsForbiddenCommandCharacter(path)) return false;
  const DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ||
      (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    return false;
  }
  *output = std::move(path);
  return true;
}

std::wstring DirectoryName(const std::wstring& path) {
  const size_t separator = path.find_last_of(L"\\/");
  return separator == std::wstring::npos ? std::wstring() : path.substr(0, separator);
}

std::wstring QuoteArgument(const std::wstring& value) {
  return L"\"" + value + L"\"";
}

#ifdef XIAOQIE_CONTAINMENT_TEST_BUILD
bool IsAllowedFaultMode(const std::wstring& mode) {
  static constexpr std::array<const wchar_t*, 15> kModes = {
      L"bad-handshake", L"ack-invalid", L"crash", L"duplicate-id", L"env-check",
      L"eof", L"hang", L"malformed", L"no-handshake", L"oversized",
      L"unknown-field", L"unknown-type", L"credential-result", L"wrong-result",
      L"wrong-id",
  };
  return std::any_of(kModes.begin(), kModes.end(), [&](const wchar_t* candidate) {
    return EqualsIgnoreCase(mode, candidate);
  });
}

FaultStage ParseFaultStage(const std::wstring& stage) {
  if (stage == L"none") return FaultStage::kNone;
  if (stage == L"job") return FaultStage::kJob;
  if (stage == L"token") return FaultStage::kToken;
  if (stage == L"create") return FaultStage::kCreate;
  if (stage == L"assign") return FaultStage::kAssign;
  if (stage == L"attestation") return FaultStage::kAttestation;
  if (stage == L"resume") return FaultStage::kResume;
  return static_cast<FaultStage>(-1);
}
#endif

bool BuildLaunchConfiguration(
    int argc,
    wchar_t** argv,
    std::wstring* node_path,
    std::wstring* worker_path,
    std::wstring* worker_mode,
    FaultStage* fault_stage) {
  if (node_path == nullptr || worker_path == nullptr || worker_mode == nullptr ||
      fault_stage == nullptr) {
    return false;
  }
#ifdef XIAOQIE_CONTAINMENT_TEST_BUILD
  if (argc != 5) return false;
#else
  if (argc != 3) return false;
#endif
  if (!CanonicalExistingFile(argv[1], node_path) ||
      !EndsWithIgnoreCase(*node_path, L"\\node.exe")) {
    return false;
  }
  if (!CanonicalExistingFile(argv[2], worker_path)) return false;
#ifdef XIAOQIE_CONTAINMENT_TEST_BUILD
  const bool allowed_worker =
      EndsWithIgnoreCase(*worker_path, L"\\dist\\tests\\fixtures\\fault-adapter-worker.js") ||
      EndsWithIgnoreCase(*worker_path, L"\\dist\\tests\\fixtures\\containment-probe-worker.js");
  if (!allowed_worker) return false;
  *worker_mode = argv[3];
  if (!IsAllowedFaultMode(*worker_mode) &&
      !EqualsIgnoreCase(*worker_mode, L"probe-attestation") &&
      !EqualsIgnoreCase(*worker_mode, L"probe-child") &&
      !EqualsIgnoreCase(*worker_mode, L"probe-memory") &&
      !EqualsIgnoreCase(*worker_mode, L"probe-cpu") &&
      !EqualsIgnoreCase(*worker_mode, L"probe-parent-liveness")) {
    return false;
  }
  *fault_stage = ParseFaultStage(argv[4]);
  return static_cast<int>(*fault_stage) >= 0;
#else
  if (!EndsWithIgnoreCase(*worker_path, L"\\dist\\src\\adapters\\mock\\mock-worker.js")) {
    return false;
  }
  *worker_mode = L"product";
  *fault_stage = FaultStage::kNone;
  return true;
#endif
}

bool CreateKnownSid(WELL_KNOWN_SID_TYPE type, std::vector<BYTE>* storage) {
  if (storage == nullptr) return false;
  storage->assign(SECURITY_MAX_SID_SIZE, 0);
  DWORD size = static_cast<DWORD>(storage->size());
  if (!CreateWellKnownSid(type, nullptr, storage->data(), &size)) return false;
  storage->resize(size);
  return true;
}

bool QueryTokenBuffer(HANDLE token, TOKEN_INFORMATION_CLASS information_class,
                      std::vector<BYTE>* buffer) {
  if (buffer == nullptr) return false;
  DWORD required = 0;
  GetTokenInformation(token, information_class, nullptr, 0, &required);
  if (required == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER) return false;
  buffer->assign(required, 0);
  return GetTokenInformation(token, information_class, buffer->data(), required, &required) != FALSE;
}

bool IsCurrentProcessElevated() {
  UniqueHandle token;
  HANDLE raw = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)) return true;
  token.reset(raw);
  TOKEN_ELEVATION elevation{};
  DWORD size = 0;
  if (!GetTokenInformation(token.get(), TokenElevation, &elevation, sizeof(elevation), &size)) {
    return true;
  }
  return elevation.TokenIsElevated != 0;
}

bool IsDangerousPrivilegeEnabled(HANDLE token) {
  static constexpr std::array<const wchar_t*, 14> kDangerousPrivileges = {
      SE_ASSIGNPRIMARYTOKEN_NAME, SE_TCB_NAME, SE_CREATE_TOKEN_NAME, SE_DEBUG_NAME,
      SE_IMPERSONATE_NAME, SE_INCREASE_QUOTA_NAME, SE_LOAD_DRIVER_NAME, SE_BACKUP_NAME,
      SE_RESTORE_NAME, SE_TAKE_OWNERSHIP_NAME, SE_SECURITY_NAME, SE_SYSTEM_ENVIRONMENT_NAME,
      SE_MANAGE_VOLUME_NAME, SE_RELABEL_NAME,
  };
  std::array<LUID, kDangerousPrivileges.size()> dangerous{};
  for (size_t index = 0; index < kDangerousPrivileges.size(); ++index) {
    if (!LookupPrivilegeValueW(nullptr, kDangerousPrivileges[index], &dangerous[index])) return true;
  }
  std::vector<BYTE> buffer;
  if (!QueryTokenBuffer(token, TokenPrivileges, &buffer)) return true;
  const auto* privileges = reinterpret_cast<const TOKEN_PRIVILEGES*>(buffer.data());
  for (DWORD index = 0; index < privileges->PrivilegeCount; ++index) {
    if ((privileges->Privileges[index].Attributes & SE_PRIVILEGE_ENABLED) == 0) continue;
    for (const LUID& candidate : dangerous) {
      if (candidate.LowPart == privileges->Privileges[index].Luid.LowPart &&
          candidate.HighPart == privileges->Privileges[index].Luid.HighPart) {
        return true;
      }
    }
  }
  return false;
}

bool RestrictingSidsMatch(HANDLE token,
                          const std::vector<SID_AND_ATTRIBUTES>& expected_sids) {
  std::vector<BYTE> buffer;
  if (!QueryTokenBuffer(token, TokenRestrictedSids, &buffer)) return false;
  const auto* groups = reinterpret_cast<const TOKEN_GROUPS*>(buffer.data());
  if (groups->GroupCount != static_cast<DWORD>(expected_sids.size())) return false;
  for (const auto& expected : expected_sids) {
    bool present = false;
    for (DWORD index = 0; index < groups->GroupCount; ++index) {
      present = present || EqualSid(groups->Groups[index].Sid, expected.Sid);
    }
    if (!present) return false;
  }
  return true;
}

bool DisabledGroupsAreDenyOnly(HANDLE token, const std::vector<std::vector<BYTE>>& disabled_sids) {
  std::vector<BYTE> buffer;
  if (!QueryTokenBuffer(token, TokenGroups, &buffer)) return false;
  const auto* groups = reinterpret_cast<const TOKEN_GROUPS*>(buffer.data());
  for (const auto& sid_storage : disabled_sids) {
    bool present = false;
    for (DWORD index = 0; index < groups->GroupCount; ++index) {
      if (!EqualSid(groups->Groups[index].Sid,
                    const_cast<BYTE*>(sid_storage.data()))) {
        continue;
      }
      present = true;
      const DWORD attributes = groups->Groups[index].Attributes;
      if ((attributes & SE_GROUP_ENABLED) != 0 &&
          (attributes & SE_GROUP_USE_FOR_DENY_ONLY) == 0) {
        return false;
      }
    }
    (void)present;
  }
  return true;
}

const char* IntegrityCategory(HANDLE token) {
  std::vector<BYTE> buffer;
  if (!QueryTokenBuffer(token, TokenIntegrityLevel, &buffer)) return nullptr;
  const auto* label = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(buffer.data());
  if (!IsValidSid(label->Label.Sid)) return nullptr;
  const UCHAR count = *GetSidSubAuthorityCount(label->Label.Sid);
  if (count == 0) return nullptr;
  const DWORD rid = *GetSidSubAuthority(label->Label.Sid, count - 1);
  if (rid < SECURITY_MANDATORY_MEDIUM_RID) return "low";
  if (rid < SECURITY_MANDATORY_HIGH_RID) return "medium";
  return nullptr;
}

bool ValidateRestrictedToken(
    HANDLE token,
    const std::vector<SID_AND_ATTRIBUTES>& restricting_sids,
    const std::vector<std::vector<BYTE>>& disabled_sids,
    const char** integrity) {
  BOOL restricted = FALSE;
  DWORD size = 0;
  if (!GetTokenInformation(token, TokenIsRestricted, &restricted, sizeof(restricted), &size) ||
      !restricted || IsDangerousPrivilegeEnabled(token) ||
      !RestrictingSidsMatch(token, restricting_sids) ||
      !DisabledGroupsAreDenyOnly(token, disabled_sids)) {
    return false;
  }
  *integrity = IntegrityCategory(token);
  return *integrity != nullptr;
}

bool ConfigureJob(HANDLE job) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
      JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
  limits.BasicLimitInformation.ActiveProcessLimit = kActiveProcessLimit;
  limits.ProcessMemoryLimit = kProcessMemoryLimitBytes;
  limits.JobMemoryLimit = kJobMemoryLimitBytes;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    return false;
  }
  JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu{};
  cpu.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
  cpu.CpuRate = kCpuRate;
  return SetInformationJobObject(job, JobObjectCpuRateControlInformation, &cpu, sizeof(cpu)) != FALSE;
}

bool ValidateJob(HANDLE job, HANDLE process) {
  BOOL in_job = FALSE;
  if (!IsProcessInJob(process, job, &in_job) || !in_job) return false;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  if (!QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits),
                                 nullptr)) {
    return false;
  }
  const DWORD required_flags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
      JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
  if ((limits.BasicLimitInformation.LimitFlags & required_flags) != required_flags ||
      (limits.BasicLimitInformation.LimitFlags &
       (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)) != 0 ||
      limits.BasicLimitInformation.ActiveProcessLimit != kActiveProcessLimit ||
      limits.ProcessMemoryLimit != kProcessMemoryLimitBytes ||
      limits.JobMemoryLimit != kJobMemoryLimitBytes) {
    return false;
  }
  JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu{};
  if (!QueryInformationJobObject(job, JobObjectCpuRateControlInformation, &cpu, sizeof(cpu),
                                 nullptr) ||
      (cpu.ControlFlags &
       (JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP)) !=
          (JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP) ||
      cpu.CpuRate != kCpuRate) {
    return false;
  }
  std::array<BYTE, sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + sizeof(ULONG_PTR) * 3> list{};
  auto* process_list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(list.data());
  if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, process_list,
                                 static_cast<DWORD>(list.size()), nullptr) ||
      process_list->NumberOfAssignedProcesses != 1 ||
      process_list->NumberOfProcessIdsInList != 1) {
    return false;
  }
  return true;
}

HANDLE ParentLivenessPipe() {
  // Standard handles are a Win32 process contract across CRTs. Keep an exact,
  // non-inheritable duplicate of the fixed stdin/IPC pipe for parent-liveness
  // monitoring; the original is passed to the worker and then closed locally.
  HANDLE standard_input = GetStdHandle(STD_INPUT_HANDLE);
  if (standard_input == nullptr || standard_input == INVALID_HANDLE_VALUE ||
      GetFileType(standard_input) != FILE_TYPE_PIPE) {
    return INVALID_HANDLE_VALUE;
  }
  DWORD flags = 0;
  if (!GetNamedPipeInfo(standard_input, &flags, nullptr, nullptr, nullptr)) {
    return INVALID_HANDLE_VALUE;
  }
  HANDLE duplicate = INVALID_HANDLE_VALUE;
  if (!DuplicateHandle(GetCurrentProcess(), standard_input, GetCurrentProcess(), &duplicate,
                       0, FALSE, DUPLICATE_SAME_ACCESS)) {
    return INVALID_HANDLE_VALUE;
  }
  return duplicate;
}

bool ParentLivenessPipeIsOpen(HANDLE handle) {
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE ||
      GetFileType(handle) != FILE_TYPE_PIPE) {
    return false;
  }
  DWORD available = 0;
  return PeekNamedPipe(handle, nullptr, 0, nullptr, &available, nullptr) != FALSE;
}

bool BuildEnvironment(const std::wstring& mode, std::vector<wchar_t>* environment) {
  if (environment == nullptr) return false;
  std::array<wchar_t, MAX_PATH + 1> windows_directory{};
  const UINT length = GetWindowsDirectoryW(windows_directory.data(),
                                            static_cast<UINT>(windows_directory.size()));
  if (length == 0 || length >= static_cast<UINT>(windows_directory.size())) return false;
  std::vector<std::wstring> entries = {
      std::wstring(L"SystemRoot=") + windows_directory.data(),
      L"XIAOQIE_ADAPTER_WORKER=mock-v1",
  };
#ifdef XIAOQIE_CONTAINMENT_TEST_BUILD
  entries.push_back(std::wstring(L"XIAOQIE_TEST_MODE=") + mode);
#else
  (void)mode;
#endif
  std::sort(entries.begin(), entries.end(), [](const std::wstring& left, const std::wstring& right) {
    return _wcsicmp(left.c_str(), right.c_str()) < 0;
  });
  size_t total = 1;
  for (const auto& entry : entries) total += entry.size() + 1;
  environment->assign(total, L'\0');
  size_t offset = 0;
  for (const auto& entry : entries) {
    std::copy(entry.begin(), entry.end(), environment->begin() + offset);
    offset += entry.size() + 1;
  }
  return true;
}

bool WriteAttestation(HANDLE output, const char* integrity, bool host_in_job) {
  if (output == nullptr || output == INVALID_HANDLE_VALUE || integrity == nullptr) return false;
  char message[768]{};
  const int length = std::snprintf(
      message, sizeof(message),
      "{\"version\":1,\"type\":\"containment-ready\",\"attestation\":{"
      "\"tokenRestricted\":true,\"dangerousPrivilegesDisabled\":true,"
      "\"privilegedGroupsDisabledOrDenyOnly\":true,"
      "\"restrictingSidPolicy\":\"source-user-and-enabled-groups\","
      "\"integrity\":\"%s\",\"jobAssigned\":true,\"killOnClose\":true,"
      "\"activeProcessLimit\":1,\"processMemoryLimitBytes\":268435456,"
      "\"jobMemoryLimitBytes\":201326592,\"cpuRatePercent\":20,"
      "\"breakawayAllowed\":false,\"hostJob\":\"%s\"}}\n",
      integrity, host_in_job ? "nested" : "none");
  if (length <= 0 || static_cast<size_t>(length) >= sizeof(message)) return false;
  DWORD written = 0;
  return WriteFile(output, message, static_cast<DWORD>(length), &written, nullptr) != FALSE &&
         written == static_cast<DWORD>(length);
}

bool WriteContainmentFaultIfPresent(HANDLE job, HANDLE output) {
  const char* category = nullptr;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  if (QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                                sizeof(limits), nullptr) &&
      (limits.PeakJobMemoryUsed >= (kJobMemoryLimitBytes * 99) / 100 ||
       limits.PeakProcessMemoryUsed >= (kProcessMemoryLimitBytes * 99) / 100)) {
    category = "memory-limit";
  }
  JOBOBJECT_LIMIT_VIOLATION_INFORMATION violation{};
  if (category == nullptr &&
      QueryInformationJobObject(job, JobObjectLimitViolationInformation, &violation,
                                sizeof(violation), nullptr) &&
      (violation.ViolationLimitFlags & JOB_OBJECT_LIMIT_JOB_MEMORY) != 0) {
    category = "memory-limit";
  }
  if (category == nullptr) return false;
  char message[128]{};
  const int length = std::snprintf(
      message, sizeof(message),
      "{\"version\":1,\"type\":\"containment-fault\",\"category\":\"%s\"}\n",
      category);
  if (length <= 0 || static_cast<size_t>(length) >= sizeof(message)) return false;
  DWORD written = 0;
  return WriteFile(output, message, static_cast<DWORD>(length), &written, nullptr) != FALSE &&
         written == static_cast<DWORD>(length);
}

#ifdef XIAOQIE_CONTAINMENT_TEST_BUILD
bool VerifyProcessLimitWithSuspendedCandidate(
    HANDLE job, HANDLE restricted_token,
    const std::wstring& node_path, const std::wstring& worker_path,
    const std::wstring& working_directory, std::vector<wchar_t>* environment) {
  if (environment == nullptr) return false;
  std::wstring command_line = QuoteArgument(node_path) + L" " + QuoteArgument(worker_path);
  std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
  mutable_command.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = static_cast<DWORD>(sizeof(startup));
  PROCESS_INFORMATION candidate_info{};
  if (!CreateProcessAsUserW(
          restricted_token, node_path.c_str(), mutable_command.data(), nullptr, nullptr, FALSE,
          CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
          environment->data(), working_directory.c_str(), &startup, &candidate_info)) {
    return false;
  }
  UniqueHandle candidate_process(candidate_info.hProcess);
  UniqueHandle candidate_thread(candidate_info.hThread);

  const BOOL assigned = AssignProcessToJobObject(job, candidate_process.get());
  const DWORD assignment_error = GetLastError();
  if (assigned) {
    TerminateProcess(candidate_process.get(), kExitWorker);
    WaitForSingleObject(candidate_process.get(), kParentExitWaitMs);
    return false;
  }
  if (assignment_error != ERROR_NOT_ENOUGH_QUOTA) {
    TerminateProcess(candidate_process.get(), kExitWorker);
    WaitForSingleObject(candidate_process.get(), kParentExitWaitMs);
    return false;
  }
  if (WaitForSingleObject(candidate_process.get(), 0) != WAIT_OBJECT_0 &&
      (!TerminateProcess(candidate_process.get(), kExitWorker) ||
       WaitForSingleObject(candidate_process.get(), kParentExitWaitMs) != WAIT_OBJECT_0)) {
    return false;
  }
  DWORD candidate_exit = STILL_ACTIVE;
  if (!GetExitCodeProcess(candidate_process.get(), &candidate_exit) ||
      candidate_exit == STILL_ACTIVE) {
    return false;
  }

  return true;
}

bool VerifyProcessLimitAccounting(HANDLE job, HANDLE worker_process) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  std::array<BYTE, sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + sizeof(ULONG_PTR) * 2> list{};
  auto* process_list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(list.data());
  return QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting,
                                   sizeof(accounting), nullptr) != FALSE &&
         QueryInformationJobObject(job, JobObjectBasicProcessIdList, process_list,
                                   static_cast<DWORD>(list.size()), nullptr) != FALSE &&
         accounting.ActiveProcesses == 1 &&
         process_list->NumberOfAssignedProcesses == 1 &&
         process_list->NumberOfProcessIdsInList == 1 &&
         process_list->ProcessIdList[0] == static_cast<ULONG_PTR>(GetProcessId(worker_process));
}

bool VerifyProcessLimitPostAttempt(HANDLE job) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  std::array<BYTE, sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + sizeof(ULONG_PTR) * 2> list{};
  auto* process_list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(list.data());
  return QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                                   sizeof(limits), nullptr) != FALSE &&
         QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting,
                                   sizeof(accounting), nullptr) != FALSE &&
         QueryInformationJobObject(job, JobObjectBasicProcessIdList, process_list,
                                   static_cast<DWORD>(list.size()), nullptr) != FALSE &&
         (limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_ACTIVE_PROCESS) != 0 &&
         (limits.BasicLimitInformation.LimitFlags &
          (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)) == 0 &&
         limits.BasicLimitInformation.ActiveProcessLimit == kActiveProcessLimit &&
         accounting.ActiveProcesses == 0 &&
         process_list->NumberOfAssignedProcesses == 0 &&
         process_list->NumberOfProcessIdsInList == 0;
}

bool WriteProcessLimitProbeEvidence(HANDLE output) {
  static constexpr char kMessage[] =
      "{\"version\":1,\"type\":\"containment-probe-result\","
      "\"category\":\"process-limit\",\"quotaRejection\":true,"
      "\"candidateTerminationConfirmed\":true,\"postAttemptActiveProcesses\":0,"
      "\"postAttemptLiveJobMembers\":0,\"noEscapedLiveChild\":true}\n";
  DWORD written = 0;
  return WriteFile(output, kMessage, static_cast<DWORD>(sizeof(kMessage) - 1), &written,
                   nullptr) != FALSE &&
         written == static_cast<DWORD>(sizeof(kMessage) - 1);
}

bool WriteParentLivenessProbeEvidence(HANDLE output) {
  static constexpr char kMessage[] =
      "{\"version\":1,\"type\":\"containment-probe-result\","
      "\"category\":\"parent-liveness\",\"workerTerminationConfirmed\":true}\n";
  DWORD written = 0;
  return output != nullptr && output != INVALID_HANDLE_VALUE &&
         WriteFile(output, kMessage, static_cast<DWORD>(sizeof(kMessage) - 1), &written,
                   nullptr) != FALSE &&
         written == static_cast<DWORD>(sizeof(kMessage) - 1);
}
#endif

void TerminateSuspendedProcess(HANDLE process) {
  if (process == nullptr || process == INVALID_HANDLE_VALUE) return;
  TerminateProcess(process, kExitAssign);
  WaitForSingleObject(process, kParentExitWaitMs);
}

void CloseLocalStandardHandle(DWORD kind, HANDLE handle) {
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE) return;
  SetStdHandle(kind, INVALID_HANDLE_VALUE);
  CloseHandle(handle);
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  std::wstring node_path;
  std::wstring worker_path;
  std::wstring worker_mode;
  FaultStage fault_stage = FaultStage::kNone;
  if (!BuildLaunchConfiguration(argc, argv, &node_path, &worker_path, &worker_mode,
                                &fault_stage)) {
    return kExitInvalidLaunch;
  }
  if (IsCurrentProcessElevated()) return kExitHostPolicy;

  BOOL host_in_job = FALSE;
  if (!IsProcessInJob(GetCurrentProcess(), nullptr, &host_in_job)) return kExitHostPolicy;
  UniqueHandle parent_liveness(ParentLivenessPipe());
  if (!ParentLivenessPipeIsOpen(parent_liveness.get())) return kExitHostPolicy;

  UniqueHandle job(CreateJobObjectW(nullptr, nullptr));
  if (!job || fault_stage == FaultStage::kJob || !ConfigureJob(job.get())) return kExitJob;

  UniqueHandle source_token;
  HANDLE raw_source_token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(),
                        TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY,
                        &raw_source_token)) {
    return kExitToken;
  }
  source_token.reset(raw_source_token);

  std::vector<std::vector<BYTE>> disabled_sid_storage(5);
  const std::array<WELL_KNOWN_SID_TYPE, 5> disabled_sid_types = {
      WinBuiltinAdministratorsSid, WinBuiltinPowerUsersSid, WinBuiltinAccountOperatorsSid,
      WinBuiltinSystemOperatorsSid, WinBuiltinBackupOperatorsSid,
  };
  std::vector<SID_AND_ATTRIBUTES> disabled_sids;
  disabled_sids.reserve(disabled_sid_types.size());
  for (size_t index = 0; index < disabled_sid_types.size(); ++index) {
    if (!CreateKnownSid(disabled_sid_types[index], &disabled_sid_storage[index])) return kExitToken;
    disabled_sids.push_back({disabled_sid_storage[index].data(), 0});
  }
  std::vector<BYTE> current_user_storage;
  if (!QueryTokenBuffer(source_token.get(), TokenUser, &current_user_storage)) return kExitToken;
  const auto* current_user = reinterpret_cast<const TOKEN_USER*>(current_user_storage.data());
  if (!IsValidSid(current_user->User.Sid)) return kExitToken;
  std::vector<BYTE> source_groups_storage;
  if (!QueryTokenBuffer(source_token.get(), TokenGroups, &source_groups_storage)) return kExitToken;
  const auto* source_groups = reinterpret_cast<const TOKEN_GROUPS*>(source_groups_storage.data());
  std::vector<SID_AND_ATTRIBUTES> restricting_sids = {{current_user->User.Sid, 0}};
  for (DWORD group_index = 0; group_index < source_groups->GroupCount; ++group_index) {
    const SID_AND_ATTRIBUTES group = source_groups->Groups[group_index];
    if ((group.Attributes & SE_GROUP_ENABLED) == 0 ||
        (group.Attributes & (SE_GROUP_USE_FOR_DENY_ONLY | SE_GROUP_INTEGRITY)) != 0) {
      continue;
    }
    const bool disabled = std::any_of(
        disabled_sid_storage.begin(), disabled_sid_storage.end(),
        [&](const std::vector<BYTE>& candidate) {
          return EqualSid(group.Sid, const_cast<BYTE*>(candidate.data())) != FALSE;
        });
    if (!disabled) restricting_sids.push_back({group.Sid, 0});
  }
  if (fault_stage == FaultStage::kToken) return kExitToken;
  UniqueHandle restricted_token;
  HANDLE raw_restricted_token = nullptr;
  if (!CreateRestrictedToken(
          source_token.get(), DISABLE_MAX_PRIVILEGE, static_cast<DWORD>(disabled_sids.size()),
          disabled_sids.data(), 0, nullptr, static_cast<DWORD>(restricting_sids.size()),
          restricting_sids.data(), &raw_restricted_token)) {
    return kExitToken;
  }
  restricted_token.reset(raw_restricted_token);
  const char* integrity = nullptr;
  if (!ValidateRestrictedToken(restricted_token.get(), restricting_sids, disabled_sid_storage,
                               &integrity)) {
    return kExitToken;
  }

  HANDLE standard_input = GetStdHandle(STD_INPUT_HANDLE);
  HANDLE standard_output = GetStdHandle(STD_OUTPUT_HANDLE);
  SECURITY_ATTRIBUTES null_security{
      static_cast<DWORD>(sizeof(null_security)), nullptr, TRUE};
  UniqueHandle null_error(CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                      &null_security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL,
                                      nullptr));
  if (standard_input == nullptr || standard_input == INVALID_HANDLE_VALUE ||
      standard_output == nullptr || standard_output == INVALID_HANDLE_VALUE ||
      GetFileType(standard_input) != FILE_TYPE_PIPE ||
      GetFileType(standard_output) != FILE_TYPE_PIPE) {
    return kExitInvalidLaunch;
  }
  if (!null_error) return kExitInvalidLaunch;
  std::vector<HANDLE> inherited_handles = {standard_input, standard_output, null_error.get()};
  for (HANDLE handle : inherited_handles) {
    if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
      return kExitInvalidLaunch;
    }
  }

  SIZE_T attribute_bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_bytes);
  if (attribute_bytes == 0) return kExitCreate;
  AttributeList attributes;
  attributes.value = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
      HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, attribute_bytes));
  if (attributes.value == nullptr ||
      !InitializeProcThreadAttributeList(attributes.value, 1, 0, &attribute_bytes) ||
      !UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                 inherited_handles.data(),
                                 inherited_handles.size() * sizeof(HANDLE), nullptr, nullptr)) {
    return kExitCreate;
  }

  std::vector<wchar_t> environment;
  if (!BuildEnvironment(worker_mode, &environment)) return kExitCreate;
  std::wstring command_line = QuoteArgument(node_path) + L" " + QuoteArgument(worker_path);
  std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
  mutable_command.push_back(L'\0');
  const std::wstring working_directory = DirectoryName(worker_path);
  if (working_directory.empty()) return kExitCreate;

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = static_cast<DWORD>(sizeof(startup));
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = standard_input;
  startup.StartupInfo.hStdOutput = standard_output;
  startup.StartupInfo.hStdError = null_error.get();
  startup.lpAttributeList = attributes.value;
  PROCESS_INFORMATION process_info{};
  if (fault_stage == FaultStage::kCreate) return kExitCreate;
  if (!CreateProcessAsUserW(
          restricted_token.get(), node_path.c_str(), mutable_command.data(), nullptr, nullptr, TRUE,
          CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW |
              EXTENDED_STARTUPINFO_PRESENT,
          environment.data(), working_directory.c_str(), &startup.StartupInfo, &process_info)) {
    return kExitCreate;
  }
  UniqueHandle worker_process(process_info.hProcess);
  UniqueHandle worker_thread(process_info.hThread);

  if (fault_stage == FaultStage::kAssign) {
    TerminateSuspendedProcess(worker_process.get());
    return kExitAssign;
  }
  if (!AssignProcessToJobObject(job.get(), worker_process.get())) {
    TerminateSuspendedProcess(worker_process.get());
    return kExitAssign;
  }
  if (fault_stage == FaultStage::kAttestation || !ValidateJob(job.get(), worker_process.get())) {
    return kExitAttestation;
  }
  UniqueHandle worker_token;
  HANDLE raw_worker_token = nullptr;
  if (!OpenProcessToken(worker_process.get(), TOKEN_QUERY, &raw_worker_token)) return kExitAttestation;
  worker_token.reset(raw_worker_token);
  const char* worker_integrity = nullptr;
#ifdef XIAOQIE_CONTAINMENT_TEST_BUILD
  const bool process_limit_verified =
      !EqualsIgnoreCase(worker_mode, L"probe-child") ||
      (VerifyProcessLimitWithSuspendedCandidate(
           job.get(), restricted_token.get(), node_path, worker_path,
           working_directory, &environment) &&
       VerifyProcessLimitAccounting(job.get(), worker_process.get()));
#endif
  if (!ValidateRestrictedToken(worker_token.get(), restricting_sids, disabled_sid_storage,
                                &worker_integrity) ||
      std::strcmp(worker_integrity, integrity) != 0 ||
#ifdef XIAOQIE_CONTAINMENT_TEST_BUILD
      !process_limit_verified ||
#endif
      !ParentLivenessPipeIsOpen(parent_liveness.get()) ||
      !WriteAttestation(standard_output, integrity, host_in_job != FALSE)) {
    return kExitAttestation;
  }
  if (fault_stage == FaultStage::kResume || ResumeThread(worker_thread.get()) == static_cast<DWORD>(-1)) {
    return kExitResume;
  }
  worker_thread.reset();

  CloseLocalStandardHandle(STD_INPUT_HANDLE, standard_input);

  for (;;) {
    const DWORD wait_result = WaitForSingleObject(worker_process.get(), kParentLivenessPollMs);
    if (wait_result == WAIT_OBJECT_0) break;
    if (wait_result == WAIT_TIMEOUT && ParentLivenessPipeIsOpen(parent_liveness.get())) {
      continue;
    }
    if (wait_result == WAIT_TIMEOUT &&
        WaitForSingleObject(worker_process.get(), kInputCloseWorkerExitGraceMs) == WAIT_OBJECT_0) {
      break;
    }
    job.reset();
    const DWORD worker_wait = WaitForSingleObject(worker_process.get(), kParentExitWaitMs);
#ifdef XIAOQIE_CONTAINMENT_TEST_BUILD
    if (EqualsIgnoreCase(worker_mode, L"probe-parent-liveness") &&
        worker_wait == WAIT_OBJECT_0) {
      WriteParentLivenessProbeEvidence(GetStdHandle(STD_ERROR_HANDLE));
    }
#else
    (void)worker_wait;
#endif
    return kExitWorker;
  }
  DWORD worker_exit = 1;
  if (!GetExitCodeProcess(worker_process.get(), &worker_exit)) return kExitWorker;
  if (worker_exit != 0) {
    WriteContainmentFaultIfPresent(job.get(), standard_output);
  }
#ifdef XIAOQIE_CONTAINMENT_TEST_BUILD
  if (worker_exit == 0 && EqualsIgnoreCase(worker_mode, L"probe-child") &&
      (!VerifyProcessLimitPostAttempt(job.get()) ||
       !WriteProcessLimitProbeEvidence(standard_output))) {
    job.reset();
    return kExitWorker;
  }
#endif
  job.reset();
  return worker_exit == 0 ? 0 : kExitWorker;
}
