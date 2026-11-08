<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api';

const props = defineProps({ id: { type: [Number, String], required: true } });

const cert = ref(null);
const loading = ref(false);
const error = ref('');
const showConfirm = ref(false);
const revokeReason = ref('');
const revoking = ref(false);
const revokeError = ref('');

onMounted(fetchDetail);

async function fetchDetail() {
  loading.value = true;
  error.value = '';
  try {
    cert.value = await api.detail(props.id);
  } catch (e) {
    error.value = e.message || 'failed to load certificate';
  } finally {
    loading.value = false;
  }
}

function confirmRevoke() {
  showConfirm.value = true;
}

async function doRevoke() {
  revoking.value = true;
  revokeError.value = '';
  try {
    await api.revoke(props.id, revokeReason.value.trim());
    showConfirm.value = false;
    await fetchDetail();
  } catch (e) {
    revokeError.value = e.message || 'revoke failed';
  } finally {
    revoking.value = false;
  }
}
</script>

<template>
  <section class="panel">
    <p v-if="loading" class="state-loading">Loading certificate…</p>
    <p v-else-if="error" class="state-error">
      <span>{{ error }}</span>
      <button @click="fetchDetail">Retry</button>
    </p>

    <template v-else-if="cert">
      <h2>Certificate {{ cert.serial }}</h2>
      <dl class="detail">
        <dt>Serial number</dt><dd>{{ cert.serial }}</dd>
        <dt>Course</dt><dd>{{ cert.course_title }}</dd>
        <dt>Learner</dt><dd>{{ cert.learner_name }}</dd>
        <dt>Issue date</dt><dd>{{ cert.localDateTime }}</dd>
        <dt>Status</dt><dd><span class="status-tag" :class="`status-${cert.status}`">{{ cert.status }}</span></dd>
        <template v-if="cert.status === 'revoked'">
          <dt>Revoked at</dt><dd>{{ new Date(cert.revoked_at_utc).toISOString() }}</dd>
          <dt>Reason</dt><dd>{{ cert.revoke_reason || '—' }}</dd>
        </template>
      </dl>

      <div style="margin-top: 16px">
        <button
          v-if="cert.status === 'active'"
          class="ghost-danger"
          :disabled="revoking"
          @click="confirmRevoke"
        >
          Revoke certificate
        </button>
        <span v-else class="section-note">Certificate already revoked.</span>
      </div>
      <p v-if="revokeError" class="state-error">{{ revokeError }}</p>

      <div v-if="cert.audits && cert.audits.length" style="margin-top: 20px">
        <h2 style="margin-bottom: 8px">Audit trail</h2>
        <table>
          <thead><tr><th>Action</th><th>Actor</th><th>At (UTC)</th><th>Reason</th></tr></thead>
          <tbody>
            <tr v-for="(a, i) in cert.audits" :key="i">
              <td>{{ a.action }}</td>
              <td>{{ a.actor }}</td>
              <td>{{ new Date(a.at_utc).toISOString() }}</td>
              <td>{{ a.reason || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>

  <div v-if="showConfirm" class="modal-backdrop" @click.self="showConfirm = false">
    <div class="modal">
      <h3>Revoke certificate {{ cert?.serial }}</h3>
      <p class="section-note">This will mark the certificate as revoked and write a revocation audit event. This action is audited.</p>
      <input
        v-model="revokeReason"
        type="text"
        placeholder="Reason (optional)"
        style="width: 100%; margin-top: 8px"
      />
      <p v-if="revokeError" class="state-error">{{ revokeError }}</p>
      <div class="modal-actions">
        <button class="ghost" :disabled="revoking" @click="showConfirm = false">Cancel</button>
        <button class="danger" :disabled="revoking" @click="doRevoke">
          {{ revoking ? 'Revoking…' : 'Confirm revocation' }}
        </button>
      </div>
    </div>
  </div>
</template>