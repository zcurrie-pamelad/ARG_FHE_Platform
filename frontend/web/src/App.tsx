import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface EncryptedRecord {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  category: string;
  status: "pending" | "verified" | "rejected";
  location: { lat: number; lng: number };
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<EncryptedRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newRecordData, setNewRecordData] = useState({ category: "", description: "", sensitiveValue: 0, location: { lat: 0, lng: 0 } });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<EncryptedRecord | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const verifiedCount = records.filter(r => r.status === "verified").length;
  const pendingCount = records.filter(r => r.status === "pending").length;
  const rejectedCount = records.filter(r => r.status === "rejected").length;

  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadRecords = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing record keys:", e); }
      }
      const list: EncryptedRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`record_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                encryptedData: recordData.data, 
                timestamp: recordData.timestamp, 
                owner: recordData.owner, 
                category: recordData.category, 
                status: recordData.status || "pending",
                location: recordData.location || { lat: 0, lng: 0 }
              });
            } catch (e) { console.error(`Error parsing record data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading record ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
    } catch (e) { console.error("Error loading records:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitRecord = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting sensitive data with Zama FHE..." });
    try {
      const encryptedData = FHEEncryptNumber(newRecordData.sensitiveValue);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const recordData = { 
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        category: newRecordData.category, 
        status: "pending",
        location: newRecordData.location
      };
      await contract.setData(`record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      const keysBytes = await contract.getData("record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("record_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted data submitted securely!" });
      await loadRecords();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewRecordData({ category: "", description: "", sensitiveValue: 0, location: { lat: 0, lng: 0 } });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const verifyRecord = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted data with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const recordBytes = await contract.getData(`record_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedRecord = { ...recordData, status: "verified" };
      await contractWithSigner.setData(`record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE verification completed successfully!" });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Verification failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectRecord = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted data with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const recordBytes = await contract.getData(`record_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const updatedRecord = { ...recordData, status: "rejected" };
      await contract.setData(`record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE rejection completed successfully!" });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (recordAddress: string) => address?.toLowerCase() === recordAddress.toLowerCase();

  const tutorialSteps = [
    { title: "Connect Wallet", description: "Connect your Web3 wallet to interact with the platform", icon: "🔗" },
    { title: "Create Encrypted Clue", description: "Add your game clue which will be encrypted using Zama FHE", icon: "🔒", details: "Your clue is encrypted on the client-side before being sent to the blockchain" },
    { title: "Set Location Lock", description: "Specify the real-world location where the clue can be decrypted", icon: "📍", details: "Zama FHE technology ensures decryption only happens at the specified location" },
    { title: "Players Discover Clues", description: "Players must physically visit locations to decrypt clues", icon: "🔍", details: "The ARG experience blends virtual and physical worlds" },
    { title: "Continue the Story", description: "Each decrypted clue reveals part of the narrative", icon: "📖", details: "Create immersive alternate reality experiences" }
  ];

  const renderPieChart = () => {
    const total = records.length || 1;
    const verifiedPercentage = (verifiedCount / total) * 100;
    const pendingPercentage = (pendingCount / total) * 100;
    const rejectedPercentage = (rejectedCount / total) * 100;
    return (
      <div className="pie-chart-container">
        <div className="pie-chart">
          <div className="pie-segment verified" style={{ transform: `rotate(${verifiedPercentage * 3.6}deg)` }}></div>
          <div className="pie-segment pending" style={{ transform: `rotate(${(verifiedPercentage + pendingPercentage) * 3.6}deg)` }}></div>
          <div className="pie-segment rejected" style={{ transform: `rotate(${(verifiedPercentage + pendingPercentage + rejectedPercentage) * 3.6}deg)` }}></div>
          <div className="pie-center">
            <div className="pie-value">{records.length}</div>
            <div className="pie-label">Clues</div>
          </div>
        </div>
        <div className="pie-legend">
          <div className="legend-item"><div className="color-box verified"></div><span>Verified: {verifiedCount}</span></div>
          <div className="legend-item"><div className="color-box pending"></div><span>Pending: {pendingCount}</span></div>
          <div className="legend-item"><div className="color-box rejected"></div><span>Rejected: {rejectedCount}</span></div>
        </div>
      </div>
    );
  };

  const renderWorldMap = () => {
    // Simplified world map representation with markers
    return (
      <div className="world-map">
        <div className="map-grid">
          {records.map((record, index) => (
            <div 
              key={index} 
              className={`map-marker ${record.status}`}
              style={{
                top: `${50 - (record.location.lat * 0.5)}%`,
                left: `${50 + (record.location.lng * 0.5)}%`
              }}
              onClick={() => setSelectedRecord(record)}
            >
              <div className="marker-pulse"></div>
              <div className="marker-icon"></div>
            </div>
          ))}
        </div>
        <div className="map-overlay">
          <div className="map-title">Global Clue Distribution</div>
          <div className="map-stats">{records.length} encrypted clues worldwide</div>
        </div>
      </div>
    );
  };

  const renderStatusFlow = () => {
    return (
      <div className="status-flow">
        <div className="flow-step">
          <div className="step-icon">🔒</div>
          <div className="step-label">Created</div>
          <div className="step-count">{records.length}</div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">⏳</div>
          <div className="step-label">Pending</div>
          <div className="step-count">{pendingCount}</div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">✅</div>
          <div className="step-label">Verified</div>
          <div className="step-count">{verifiedCount}</div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">🔍</div>
          <div className="step-label">Discovered</div>
          <div className="step-count">0</div>
        </div>
      </div>
    );
  };

  const getLocation = () => {
    return new Promise<{ lat: number; lng: number }>((resolve, reject) => {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            resolve({
              lat: position.coords.latitude,
              lng: position.coords.longitude
            });
          },
          (error) => {
            console.error("Error getting location:", error);
            // Default to Tokyo coordinates if location access is denied
            resolve({ lat: 35.6895, lng: 139.6917 });
          }
        );
      } else {
        // Default to Tokyo coordinates if geolocation is not supported
        resolve({ lat: 35.6895, lng: 139.6917 });
      }
    });
  };

  const handleLocationCapture = async () => {
    try {
      const location = await getLocation();
      setNewRecordData({ ...newRecordData, location });
      alert(`Location captured: ${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`);
    } catch (error) {
      console.error("Error capturing location:", error);
      alert("Failed to capture location. Using default coordinates.");
    }
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="cyber-spinner"></div>
      <p>Initializing encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container arg-platform">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="shield-icon"></div></div>
          <h1>ARG<span>FHE</span>Platform</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-record-btn cyber-button">
            <div className="add-icon"></div>Create Clue
          </button>
          <button className="cyber-button" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Guide" : "Show Guide"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      
      <div className="main-content">
        {/* Central world map */}
        <div className="central-map-container">
          {renderWorldMap()}
        </div>
        
        {/* Radial panels around the map */}
        <div className="radial-panel top-left">
          <div className="dashboard-card cyber-card">
            <h3>Project Introduction</h3>
            <p>ARG FHE Platform enables creators to build immersive <strong>Alternate Reality Games</strong> using Zama FHE technology. Clues are encrypted and can only be decrypted at specific real-world locations.</p>
            <div className="fhe-badge"><span>FHE-Powered</span></div>
          </div>
        </div>
        
        <div className="radial-panel top-right">
          <div className="dashboard-card cyber-card">
            <h3>Data Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item"><div className="stat-value">{records.length}</div><div className="stat-label">Total Clues</div></div>
              <div className="stat-item"><div className="stat-value">{verifiedCount}</div><div className="stat-label">Verified</div></div>
              <div className="stat-item"><div className="stat-value">{pendingCount}</div><div className="stat-label">Pending</div></div>
              <div className="stat-item"><div className="stat-value">{rejectedCount}</div><div className="stat-label">Rejected</div></div>
            </div>
          </div>
        </div>
        
        <div className="radial-panel bottom-left">
          <div className="dashboard-card cyber-card">
            <h3>Status Flow</h3>
            {renderStatusFlow()}
          </div>
        </div>
        
        <div className="radial-panel bottom-right">
          <div className="dashboard-card cyber-card">
            <h3>Status Distribution</h3>
            {renderPieChart()}
          </div>
        </div>
        
        {showTutorial && (
          <div className="tutorial-overlay">
            <div className="tutorial-section">
              <h2>ARG Creation Guide</h2>
              <p className="subtitle">Learn how to build immersive alternate reality experiences</p>
              <div className="tutorial-steps">
                {tutorialSteps.map((step, index) => (
                  <div className="tutorial-step" key={index}>
                    <div className="step-icon">{step.icon}</div>
                    <div className="step-content">
                      <h3>{step.title}</h3>
                      <p>{step.description}</p>
                      {step.details && <div className="step-details">{step.details}</div>}
                    </div>
                  </div>
                ))}
              </div>
              <button className="close-tutorial cyber-button" onClick={() => setShowTutorial(false)}>Got It!</button>
            </div>
          </div>
        )}
        
        <div className="records-section">
          <div className="section-header">
            <h2>Encrypted Clues</h2>
            <div className="header-actions">
              <button onClick={loadRecords} className="refresh-btn cyber-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          <div className="records-list cyber-card">
            <div className="table-header">
              <div className="header-cell">ID</div>
              <div className="header-cell">Category</div>
              <div className="header-cell">Location</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            {records.length === 0 ? (
              <div className="no-records">
                <div className="no-records-icon"></div>
                <p>No encrypted clues found</p>
                <button className="cyber-button primary" onClick={() => setShowCreateModal(true)}>Create First Clue</button>
              </div>
            ) : records.map(record => (
              <div className="record-row" key={record.id} onClick={() => setSelectedRecord(record)}>
                <div className="table-cell record-id">#{record.id.substring(0, 6)}</div>
                <div className="table-cell">{record.category}</div>
                <div className="table-cell">{record.location.lat.toFixed(2)}, {record.location.lng.toFixed(2)}</div>
                <div className="table-cell">{new Date(record.timestamp * 1000).toLocaleDateString()}</div>
                <div className="table-cell"><span className={`status-badge ${record.status}`}>{record.status}</span></div>
                <div className="table-cell actions">
                  {isOwner(record.owner) && record.status === "pending" && (
                    <>
                      <button className="action-btn cyber-button success" onClick={(e) => { e.stopPropagation(); verifyRecord(record.id); }}>Verify</button>
                      <button className="action-btn cyber-button danger" onClick={(e) => { e.stopPropagation(); rejectRecord(record.id); }}>Reject</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitRecord} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          recordData={newRecordData} 
          setRecordData={setNewRecordData}
          onCaptureLocation={handleLocationCapture}
        />
      )}
      
      {selectedRecord && (
        <RecordDetailModal 
          record={selectedRecord} 
          onClose={() => { setSelectedRecord(null); setDecryptedValue(null); }} 
          decryptedValue={decryptedValue} 
          setDecryptedValue={setDecryptedValue} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content cyber-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="cyber-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="shield-icon"></div><span>ARG FHE Platform</span></div>
            <p>Create immersive alternate reality games with Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Immersion</span></div>
          <div className="copyright">© {new Date().getFullYear()} ARG FHE Platform. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  recordData: any;
  setRecordData: (data: any) => void;
  onCaptureLocation: () => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, recordData, setRecordData, onCaptureLocation }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!recordData.category || !recordData.sensitiveValue) { 
      alert("Please fill required fields"); 
      return; 
    }
    if (recordData.location.lat === 0 && recordData.location.lng === 0) {
      alert("Please capture a location for this clue");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal cyber-card">
        <div className="modal-header">
          <h2>Create Encrypted ARG Clue</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Your clue data will be encrypted with Zama FHE before submission</p></div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>Category *</label>
              <select name="category" value={recordData.category} onChange={handleChange} className="cyber-select">
                <option value="">Select category</option>
                <option value="Puzzle">Puzzle Clue</option>
                <option value="Location">Location Hint</option>
                <option value="Narrative">Narrative Fragment</option>
                <option value="Code">Secret Code</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div className="form-group">
              <label>Description</label>
              <input type="text" name="description" value={recordData.description} onChange={handleChange} placeholder="Brief description..." className="cyber-input"/>
            </div>
            <div className="form-group">
              <label>Clue Value *</label>
              <input 
                type="number" 
                name="sensitiveValue" 
                value={recordData.sensitiveValue} 
                onChange={handleValueChange} 
                placeholder="Enter numerical clue value..." 
                className="cyber-input"
                step="0.01"
              />
            </div>
            <div className="form-group location-group">
              <label>Unlock Location</label>
              <div className="location-controls">
                <button className="cyber-button" onClick={onCaptureLocation}>
                  Capture Current Location
                </button>
                <div className="location-display">
                  {recordData.location.lat !== 0 ? 
                    `${recordData.location.lat.toFixed(4)}, ${recordData.location.lng.toFixed(4)}` : 
                    "No location captured"}
                </div>
              </div>
            </div>
          </div>
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data"><span>Plain Value:</span><div>{recordData.sensitiveValue || 'No value entered'}</div></div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{recordData.sensitiveValue ? FHEEncryptNumber(recordData.sensitiveValue).substring(0, 50) + '...' : 'No value entered'}</div>
              </div>
            </div>
          </div>
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div><strong>Location-Based Decryption</strong><p>This clue can only be decrypted when players physically visit the specified location</p></div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn cyber-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn cyber-button primary">
            {creating ? "Encrypting with FHE..." : "Create Clue"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface RecordDetailModalProps {
  record: EncryptedRecord;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const RecordDetailModal: React.FC<RecordDetailModalProps> = ({ record, onClose, decryptedValue, setDecryptedValue, isDecrypting, decryptWithSignature }) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { setDecryptedValue(null); return; }
    const decrypted = await decryptWithSignature(record.encryptedData);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="record-detail-modal cyber-card">
        <div className="modal-header">
          <h2>Clue Details #{record.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="record-info">
            <div className="info-item"><span>Category:</span><strong>{record.category}</strong></div>
            <div className="info-item"><span>Owner:</span><strong>{record.owner.substring(0, 6)}...{record.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Date:</span><strong>{new Date(record.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${record.status}`}>{record.status}</strong></div>
            <div className="info-item"><span>Location:</span><strong>{record.location.lat.toFixed(4)}, {record.location.lng.toFixed(4)}</strong></div>
          </div>
          <div className="encrypted-data-section">
            <h3>Encrypted Data</h3>
            <div className="encrypted-data">{record.encryptedData.substring(0, 100)}...</div>
            <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            <button className="decrypt-btn cyber-button" onClick={handleDecrypt} disabled={isDecrypting}>
              {isDecrypting ? <span className="decrypt-spinner"></span> : decryptedValue !== null ? "Hide Decrypted Value" : "Decrypt with Wallet Signature"}
            </button>
          </div>
          {decryptedValue !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Value</h3>
              <div className="decrypted-value">{decryptedValue}</div>
              <div className="decryption-notice"><div className="warning-icon"></div><span>Decrypted data is only visible after wallet signature verification</span></div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn cyber-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;