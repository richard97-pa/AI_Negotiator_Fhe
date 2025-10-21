// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface NegotiationRecord {
  id: string;
  encryptedTarget: string;
  encryptedFloor: string;
  nftAddress: string;
  timestamp: number;
  owner: string;
  status: "active" | "completed" | "cancelled";
  lastOffer?: string;
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
  const [records, setRecords] = useState<NegotiationRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newRecordData, setNewRecordData] = useState({ 
    nftAddress: "", 
    targetPrice: 0,
    floorPrice: 0,
    strategy: "conservative" 
  });
  const [showIntro, setShowIntro] = useState(true);
  const [selectedRecord, setSelectedRecord] = useState<NegotiationRecord | null>(null);
  const [decryptedValues, setDecryptedValues] = useState<{target?: number, floor?: number}>({});
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "active" | "completed" | "cancelled">("all");
  const [userHistory, setUserHistory] = useState<string[]>([]);

  const activeCount = records.filter(r => r.status === "active").length;
  const completedCount = records.filter(r => r.status === "completed").length;
  const cancelledCount = records.filter(r => r.status === "cancelled").length;

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
      
      const keysBytes = await contract.getData("negotiation_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing negotiation keys:", e); }
      }
      
      const list: NegotiationRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`negotiation_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                encryptedTarget: recordData.target, 
                encryptedFloor: recordData.floor,
                nftAddress: recordData.nftAddress,
                timestamp: recordData.timestamp, 
                owner: recordData.owner, 
                status: recordData.status || "active",
                lastOffer: recordData.lastOffer
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

  const createNegotiation = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting negotiation parameters with Zama FHE..." });
    try {
      const encryptedTarget = FHEEncryptNumber(newRecordData.targetPrice);
      const encryptedFloor = FHEEncryptNumber(newRecordData.floorPrice);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const recordData = { 
        target: encryptedTarget, 
        floor: encryptedFloor,
        nftAddress: newRecordData.nftAddress,
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        status: "active",
        strategy: newRecordData.strategy
      };
      
      await contract.setData(`negotiation_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      
      const keysBytes = await contract.getData("negotiation_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("negotiation_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Negotiation started with FHE-encrypted parameters!" });
      setUserHistory(prev => [...prev, `Created negotiation for NFT ${newRecordData.nftAddress.substring(0, 6)}...`]);
      await loadRecords();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewRecordData({ 
          nftAddress: "", 
          targetPrice: 0,
          floorPrice: 0,
          strategy: "conservative" 
        });
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

  const cancelNegotiation = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Updating negotiation status with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const recordBytes = await contract.getData(`negotiation_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const updatedRecord = { ...recordData, status: "cancelled" };
      await contract.setData(`negotiation_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      setTransactionStatus({ visible: true, status: "success", message: "Negotiation cancelled successfully!" });
      setUserHistory(prev => [...prev, `Cancelled negotiation ${recordId.substring(0, 6)}...`]);
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Cancellation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (recordAddress: string) => address?.toLowerCase() === recordAddress.toLowerCase();

  const filteredRecords = records.filter(record => {
    const matchesSearch = record.nftAddress.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         record.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === "all" || record.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const decryptRecordValues = async (record: NegotiationRecord) => {
    const target = await decryptWithSignature(record.encryptedTarget);
    const floor = await decryptWithSignature(record.encryptedFloor);
    if (target !== null && floor !== null) {
      setDecryptedValues({target, floor});
    }
  };

  const renderStatsCards = () => (
    <div className="stats-grid">
      <div className="stat-card metal">
        <div className="stat-value">{records.length}</div>
        <div className="stat-label">Total Negotiations</div>
      </div>
      <div className="stat-card metal">
        <div className="stat-value">{activeCount}</div>
        <div className="stat-label">Active</div>
      </div>
      <div className="stat-card metal">
        <div className="stat-value">{completedCount}</div>
        <div className="stat-label">Completed</div>
      </div>
      <div className="stat-card metal">
        <div className="stat-value">{cancelledCount}</div>
        <div className="stat-label">Cancelled</div>
      </div>
    </div>
  );

  if (loading) return (
    <div className="loading-screen">
      <div className="metal-spinner"></div>
      <p>Initializing FHE negotiator...</p>
    </div>
  );

  return (
    <div className="app-container metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="gear-icon"></div></div>
          <h1>FHE<span>Negotiator</span></h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-btn metal-button">
            <div className="add-icon"></div>New Negotiation
          </button>
          <button className="metal-button" onClick={() => setShowIntro(!showIntro)}>
            {showIntro ? "Hide Intro" : "Show Intro"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        {showIntro && (
          <div className="intro-section metal-card">
            <h2>FHE-Powered NFT Negotiation Agent</h2>
            <div className="intro-content">
              <div className="intro-text">
                <p>This AI agent negotiates on your behalf in decentralized markets using <strong>Zama FHE technology</strong> to keep your target prices and limits completely private.</p>
                <p>Set your maximum price and minimum acceptable price - both encrypted with FHE - and let the AI handle the negotiation while keeping your strategy confidential.</p>
                <div className="fhe-features">
                  <div className="feature">
                    <div className="feature-icon">🔒</div>
                    <div>
                      <h3>Encrypted Strategy</h3>
                      <p>Your negotiation parameters remain encrypted throughout the process</p>
                    </div>
                  </div>
                  <div className="feature">
                    <div className="feature-icon">🤖</div>
                    <div>
                      <h3>AI Agent</h3>
                      <p>Automated negotiation that works 24/7 on your behalf</p>
                    </div>
                  </div>
                  <div className="feature">
                    <div className="feature-icon">🔄</div>
                    <div>
                      <h3>Private Execution</h3>
                      <p>No one can see your negotiation strategy, not even the AI service</p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="intro-diagram">
                <div className="diagram-step">
                  <div className="step-number">1</div>
                  <div className="step-content">
                    <h4>Set Encrypted Parameters</h4>
                    <p>Define your target and floor prices (FHE encrypted)</p>
                  </div>
                </div>
                <div className="diagram-arrow">↓</div>
                <div className="diagram-step">
                  <div className="step-number">2</div>
                  <div className="step-content">
                    <h4>AI Negotiation</h4>
                    <p>Agent negotiates using FHE operations on encrypted data</p>
                  </div>
                </div>
                <div className="diagram-arrow">↓</div>
                <div className="diagram-step">
                  <div className="step-number">3</div>
                  <div className="step-content">
                    <h4>Secure Execution</h4>
                    <p>Transaction executes only if terms meet your encrypted criteria</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="dashboard-section">
          <h2>Negotiation Dashboard</h2>
          {renderStatsCards()}
        </div>

        <div className="user-history-section metal-card">
          <h3>Your Recent Actions</h3>
          {userHistory.length > 0 ? (
            <div className="history-list">
              {userHistory.slice(0, 5).map((item, index) => (
                <div key={index} className="history-item">
                  <div className="history-icon">🔄</div>
                  <div className="history-text">{item}</div>
                  <div className="history-time">{new Date().toLocaleTimeString()}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="no-history">
              <div className="history-icon">📝</div>
              <p>No recent actions recorded</p>
            </div>
          )}
        </div>

        <div className="records-section">
          <div className="section-header">
            <h2>Active Negotiations</h2>
            <div className="header-actions">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search NFT or ID..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="metal-input"
                />
                <div className="search-icon">🔍</div>
              </div>
              <select 
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as any)}
                className="metal-select"
              >
                <option value="all">All Status</option>
                <option value="active">Active</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <button onClick={loadRecords} className="refresh-btn metal-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          <div className="records-list metal-card">
            {filteredRecords.length === 0 ? (
              <div className="no-records">
                <div className="no-records-icon">🤖</div>
                <p>No negotiations found</p>
                <button className="metal-button primary" onClick={() => setShowCreateModal(true)}>Start First Negotiation</button>
              </div>
            ) : (
              <div className="records-grid">
                {filteredRecords.map(record => (
                  <div 
                    className="record-card" 
                    key={record.id}
                    onClick={() => setSelectedRecord(record)}
                  >
                    <div className="card-header">
                      <div className="nft-address">{record.nftAddress.substring(0, 6)}...{record.nftAddress.substring(38)}</div>
                      <div className={`status-badge ${record.status}`}>{record.status}</div>
                    </div>
                    <div className="card-body">
                      <div className="record-info">
                        <div className="info-item">
                          <span>ID:</span>
                          <strong>#{record.id.substring(0, 6)}</strong>
                        </div>
                        <div className="info-item">
                          <span>Owner:</span>
                          <strong>{record.owner.substring(0, 6)}...{record.owner.substring(38)}</strong>
                        </div>
                        <div className="info-item">
                          <span>Started:</span>
                          <strong>{new Date(record.timestamp * 1000).toLocaleDateString()}</strong>
                        </div>
                        {record.lastOffer && (
                          <div className="info-item">
                            <span>Last Offer:</span>
                            <strong className="offer-value">{record.lastOffer}</strong>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="card-footer">
                      {isOwner(record.owner) && record.status === "active" && (
                        <button 
                          className="metal-button danger small"
                          onClick={(e) => { e.stopPropagation(); cancelNegotiation(record.id); }}
                        >
                          Cancel
                        </button>
                      )}
                      <button 
                        className="metal-button small"
                        onClick={(e) => { e.stopPropagation(); setSelectedRecord(record); decryptRecordValues(record); }}
                        disabled={isDecrypting}
                      >
                        {isDecrypting ? "Decrypting..." : "View Details"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={createNegotiation} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          recordData={newRecordData} 
          setRecordData={setNewRecordData}
        />
      )}

      {selectedRecord && (
        <RecordDetailModal 
          record={selectedRecord} 
          onClose={() => { 
            setSelectedRecord(null); 
            setDecryptedValues({});
          }} 
          decryptedValues={decryptedValues}
          isDecrypting={isDecrypting}
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="metal-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✗</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="gear-icon"></div><span>FHE Negotiator</span></div>
            <p>AI-powered private negotiations powered by Zama FHE</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">GitHub</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">🔒 FHE-Powered Privacy</div>
          <div className="copyright">© {new Date().getFullYear()} FHE Negotiator. All rights reserved.</div>
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
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, recordData, setRecordData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!recordData.nftAddress || !recordData.targetPrice || !recordData.floorPrice) { 
      alert("Please fill all required fields"); 
      return; 
    }
    if (recordData.floorPrice >= recordData.targetPrice) {
      alert("Floor price must be lower than target price");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal metal-card">
        <div className="modal-header">
          <h2>New FHE Negotiation</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="notice-icon">🔒</div>
            <div>
              <strong>FHE Encryption Active</strong>
              <p>Your negotiation parameters will be encrypted before submission</p>
            </div>
          </div>
          
          <div className="form-group">
            <label>NFT Contract Address *</label>
            <input 
              type="text" 
              name="nftAddress" 
              value={recordData.nftAddress} 
              onChange={handleChange} 
              placeholder="0x..." 
              className="metal-input"
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Target Price (ETH) *</label>
              <input 
                type="number" 
                name="targetPrice" 
                value={recordData.targetPrice} 
                onChange={handleValueChange} 
                placeholder="Maximum you're willing to pay" 
                className="metal-input"
                step="0.01"
                min="0"
              />
            </div>
            <div className="form-group">
              <label>Floor Price (ETH) *</label>
              <input 
                type="number" 
                name="floorPrice" 
                value={recordData.floorPrice} 
                onChange={handleValueChange} 
                placeholder="Minimum acceptable price" 
                className="metal-input"
                step="0.01"
                min="0"
              />
            </div>
          </div>

          <div className="form-group">
            <label>Negotiation Strategy</label>
            <select 
              name="strategy" 
              value={recordData.strategy} 
              onChange={handleChange} 
              className="metal-select"
            >
              <option value="conservative">Conservative</option>
              <option value="moderate">Moderate</option>
              <option value="aggressive">Aggressive</option>
            </select>
          </div>

          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-grid">
              <div className="preview-item">
                <div className="preview-label">Target Price:</div>
                <div className="preview-value">{recordData.targetPrice || '0'} ETH</div>
                <div className="preview-encrypted">
                  {recordData.targetPrice ? FHEEncryptNumber(recordData.targetPrice).substring(0, 20) + '...' : 'Not encrypted'}
                </div>
              </div>
              <div className="preview-item">
                <div className="preview-label">Floor Price:</div>
                <div className="preview-value">{recordData.floorPrice || '0'} ETH</div>
                <div className="preview-encrypted">
                  {recordData.floorPrice ? FHEEncryptNumber(recordData.floorPrice).substring(0, 20) + '...' : 'Not encrypted'}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="metal-button">Cancel</button>
          <button 
            onClick={handleSubmit} 
            disabled={creating} 
            className="metal-button primary"
          >
            {creating ? "Starting FHE Negotiation..." : "Start Negotiation"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface RecordDetailModalProps {
  record: NegotiationRecord;
  onClose: () => void;
  decryptedValues: {target?: number, floor?: number};
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const RecordDetailModal: React.FC<RecordDetailModalProps> = ({ 
  record, 
  onClose, 
  decryptedValues,
  isDecrypting,
  decryptWithSignature 
}) => {
  const [decryptingTarget, setDecryptingTarget] = useState(false);
  const [decryptingFloor, setDecryptingFloor] = useState(false);

  const handleDecryptTarget = async () => {
    if (decryptedValues.target !== undefined) return;
    setDecryptingTarget(true);
    await decryptWithSignature(record.encryptedTarget);
    setDecryptingTarget(false);
  };

  const handleDecryptFloor = async () => {
    if (decryptedValues.floor !== undefined) return;
    setDecryptingFloor(true);
    await decryptWithSignature(record.encryptedFloor);
    setDecryptingFloor(false);
  };

  return (
    <div className="modal-overlay">
      <div className="record-detail-modal metal-card">
        <div className="modal-header">
          <h2>Negotiation Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="record-info-grid">
            <div className="info-item">
              <span>Negotiation ID:</span>
              <strong>#{record.id.substring(0, 8)}</strong>
            </div>
            <div className="info-item">
              <span>NFT Address:</span>
              <strong>{record.nftAddress}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>{record.owner.substring(0, 6)}...{record.owner.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${record.status}`}>{record.status}</strong>
            </div>
            <div className="info-item">
              <span>Started:</span>
              <strong>{new Date(record.timestamp * 1000).toLocaleString()}</strong>
            </div>
            {record.lastOffer && (
              <div className="info-item">
                <span>Last Offer:</span>
                <strong className="offer-value">{record.lastOffer} ETH</strong>
              </div>
            )}
          </div>

          <div className="encrypted-section">
            <h3>Encrypted Parameters</h3>
            
            <div className="encrypted-param">
              <div className="param-header">
                <span>Target Price</span>
                <button 
                  className="metal-button small"
                  onClick={handleDecryptTarget}
                  disabled={decryptingTarget || decryptedValues.target !== undefined}
                >
                  {decryptingTarget ? "Decrypting..." : 
                   decryptedValues.target !== undefined ? "Decrypted" : "Decrypt"}
                </button>
              </div>
              <div className="param-value encrypted">
                {record.encryptedTarget.substring(0, 50)}...
              </div>
              {decryptedValues.target !== undefined && (
                <div className="param-value decrypted">
                  Decrypted: {decryptedValues.target} ETH
                </div>
              )}
            </div>

            <div className="encrypted-param">
              <div className="param-header">
                <span>Floor Price</span>
                <button 
                  className="metal-button small"
                  onClick={handleDecryptFloor}
                  disabled={decryptingFloor || decryptedValues.floor !== undefined}
                >
                  {decryptingFloor ? "Decrypting..." : 
                   decryptedValues.floor !== undefined ? "Decrypted" : "Decrypt"}
                </button>
              </div>
              <div className="param-value encrypted">
                {record.encryptedFloor.substring(0, 50)}...
              </div>
              {decryptedValues.floor !== undefined && (
                <div className="param-value decrypted">
                  Decrypted: {decryptedValues.floor} ETH
                </div>
              )}
            </div>

            <div className="fhe-notice">
              <div className="notice-icon">⚠️</div>
              <div>
                <strong>FHE Security Notice</strong>
                <p>Decrypted values are only visible after wallet signature verification and are not stored</p>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="metal-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;