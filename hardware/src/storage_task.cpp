#include "runtime.h"

#include <freertos/task.h>
#include <string.h>

#include "device_storage.h"

void storageTask(void* argument) {
  RuntimeContext* context = static_cast<RuntimeContext*>(argument);
  if (context == NULL) {
    vTaskDelete(NULL);
    return;
  }

  for (;;) {
    PidPersistenceRequest request;
    if (xQueueReceive(context->persistenceRequestQueue, &request,
                      portMAX_DELAY) != pdPASS) {
      continue;
    }

    // Debounce writes so a burst of updates coalesces to the latest candidate.
    PidPersistenceRequest newerRequest;
    while (xQueueReceive(context->persistenceRequestQueue, &newerRequest,
                         pdMS_TO_TICKS(2000)) == pdPASS) {
      request = newerRequest;
    }

    PidPersistenceResult result = {};
    result.revision = request.config.revision;
    memcpy(result.requestId, request.config.requestId,
           sizeof(result.requestId));
    result.success = savePidConfig(request.config);
    xQueueSend(context->persistenceResultQueue, &result,
               pdMS_TO_TICKS(100));
  }
}
